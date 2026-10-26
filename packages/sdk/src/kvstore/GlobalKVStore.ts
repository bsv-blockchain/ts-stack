import Transaction from '../transaction/Transaction.js'
import { toArray } from '../primitives/utils.js'
import LookupResolver, { type LookupAnswer } from '../overlay-tools/LookupResolver.js'
import TopicBroadcaster from '../overlay-tools/SHIPBroadcaster.js'
import { withDoubleSpendRetry } from '../overlay-tools/withDoubleSpendRetry.js'
import {
  BroadcastResponse,
  BroadcastFailure,
  isBroadcastFailure
} from '../transaction/Broadcaster.js'
import {
  WalletInterface,
  CreateActionInput,
  OutpointString,
  PubKeyHex,
  CreateActionOutput,
  HexString
} from '../wallet/Wallet.interfaces.js'
import PushDrop from '../script/templates/PushDrop.js'
import WalletClient from '../wallet/WalletClient.js'
import { Beef } from '../transaction/Beef.js'
import { Historian } from '../overlay-tools/Historian.js'
import { KVContext, kvStoreInterpreter } from './kvStoreInterpreter.js'
import { completeBoundAction } from '../wallet/completeBoundAction.js'
import {
  decodeAndVerifyKVStoreToken,
  validateKVStoreController,
  validateKVStoreKey,
  validateKVStoreProtocol,
  validateKVStoreTags,
  validateKVStoreValue
} from './kvStoreTokenValidation.js'
import {
  KVStoreConfig,
  KVStoreQuery,
  KVStoreEntry,
  KVStoreGetOptions,
  KVStoreSetOptions,
  KVStoreRemoveOptions
} from './types.js'

/**
 * Default configuration values for GlobalKVStore operations.
 * Provides sensible defaults for overlay connection and protocol settings.
 */
const DEFAULT_CONFIG: KVStoreConfig = {
  protocolID: [1, 'kvstore'],
  serviceName: 'ls_kvstore',
  tokenAmount: 1,
  topics: ['tm_kvstore'],
  networkPreset: 'mainnet',
  acceptDelayedBroadcast: false,
  overlayBroadcast: false, // Use overlay broadcasting to prevent UTXO spending on broadcast rejection.
  tokenSetDescription: '', // Will be set dynamically
  tokenUpdateDescription: '', // Will be set dynamically
  tokenRemovalDescription: '' // Will be set dynamically
}

/**
 * Implements a global key-value storage system which uses an overlay service to track key-value pairs.
 * Each key-value pair is represented by a PushDrop token output.
 * Allows getting, setting, and removing key-value pairs with optional fetching by protocolID and history tracking.
 * Token fields are controller-authenticated, but the configured lookup resolver
 * remains authoritative for current/unspent status. Security-sensitive callers
 * must independently verify fresh active-state evidence before using a remotely
 * resolved value as an authorization decision.
 */
export class GlobalKVStore {
  /**
   * The wallet interface used to create transactions and perform cryptographic operations.
   * @readonly
   */
  private readonly wallet: WalletInterface

  /**
   * Configuration for the KVStore instance containing all runtime options.
   * @private
   * @readonly
   */
  private readonly config: KVStoreConfig

  /**
   * Historian instance used to extract history from transaction outputs.
   * @private
   */
  readonly #historian: Historian<string, KVContext>

  /**
   * Lookup resolver used to query the overlay for transaction outputs.
   * @private
   */
  private readonly lookupResolver: LookupResolver

  /**
   * Topic broadcaster used to broadcast transactions to the overlay.
   * @private
   */
  private readonly topicBroadcaster: TopicBroadcaster

  /**
   * A map to store locks for each key to ensure atomic updates.
   * @private
   */
  private readonly keyLocks: Map<string, Array<(value: void | PromiseLike<void>) => void>> =
    new Map()

  /**
   * Cached user identity key
   * @private
   */
  private cachedIdentityKey: PubKeyHex | null = null

  /**
   * Creates an instance of the GlobalKVStore.
   *
   * @param {KVStoreConfig} [config={}] - Configuration options for the KVStore. Defaults to empty object.
   * @param {WalletInterface} [config.wallet] - Wallet to use for operations. Defaults to WalletClient.
   * @throws {Error} If the configuration contains invalid parameters.
   */
  constructor(config: KVStoreConfig = {}) {
    // Merge with defaults to create a fully resolved config
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.wallet = config.wallet ?? new WalletClient()
    this.#historian = new Historian<string, KVContext>(kvStoreInterpreter)
    // Resolve overlay hosts via, in order of precedence: an injected resolver,
    // otherwise a default resolver built from `networkPreset` plus any
    // `hostOverrides` / `slapTrackers`. The same resolver is shared with the
    // topic broadcaster so read lookups and the broadcaster's SHIP host
    // discovery both go through it. Note this shares the *lookup* path, not the
    // broadcast target: writes still go to whatever hosts the `ls_ship` SHIP
    // lookup returns, so pinning the broadcast backend requires that lookup to
    // return the desired host (a host override alone does not force it). With no
    // overrides this is behaviourally identical to the previous
    // networkPreset-only construction.
    // `hostOverrides` / `slapTrackers` are passed straight through; LookupResolver
    // already falls back to its defaults when they're undefined.
    this.lookupResolver =
      this.config.lookupResolver ??
      new LookupResolver({
        networkPreset: this.config.networkPreset,
        hostOverrides: this.config.hostOverrides,
        slapTrackers: this.config.slapTrackers
      })
    this.topicBroadcaster = new TopicBroadcaster(this.config.topics as string[], {
      networkPreset: this.config.networkPreset,
      resolver: this.lookupResolver
    })
  }

  /**
   * Retrieves data from the KVStore.
   * Can query by key+controller (single result), protocolID, controller, or key (multiple results).
   * A returned token authenticates its controller and contents, not the resolver's
   * claim that the outpoint is currently unspent.
   *
   * @param {KVStoreQuery} query - Query parameters sent to overlay
   * @param {KVStoreGetOptions} [options={}] - Configuration options for the get operation
   * @returns {Promise<KVStoreEntry | KVStoreEntry[] | undefined>} Single entry for key+controller queries, array for all other queries
   */
  async get(
    query: KVStoreQuery,
    options: KVStoreGetOptions = {}
  ): Promise<KVStoreEntry | KVStoreEntry[] | undefined> {
    this.#validateQuerySelectors(query)
    if (query.key != null && query.controller != null) {
      // Specific key+controller query - return single entry
      const entries = await this.queryOverlay(query, options)
      if (entries.length > 1) {
        throw new Error('KVStore lookup returned ambiguous records for a unique selector')
      }
      return entries.length > 0 ? entries[0] : undefined
    }
    return await this.queryOverlay(query, options)
  }

  /**
   * Ensures lookup pagination and ordering options are only used with a real KV selector.
   *
   * @param {KVStoreQuery} query - Query parameters sent to overlay.
   * @throws {Error} If the query does not include a valid selector.
   */
  #validateQuerySelectors(query: KVStoreQuery): void {
    if (query == null || typeof query !== 'object' || Array.isArray(query)) {
      throw new Error('KVStore query must be a plain object')
    }
    const prototype = Object.getPrototypeOf(query)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('KVStore query must be a plain object')
    }
    const allowed = new Set([
      'key',
      'controller',
      'protocolID',
      'tags',
      'tagQueryMode',
      'limit',
      'skip',
      'sortOrder'
    ])
    for (const key of Reflect.ownKeys(query)) {
      const descriptor = Object.getOwnPropertyDescriptor(query, key)
      if (
        typeof key !== 'string' ||
        !allowed.has(key) ||
        descriptor == null ||
        !('value' in descriptor)
      ) {
        throw new Error('KVStore query contains an unsupported property')
      }
    }
    if (query.key !== undefined) validateKVStoreKey(query.key)
    if (query.protocolID !== undefined) validateKVStoreProtocol(query.protocolID)
    if (query.tags !== undefined) validateKVStoreTags(query.tags)
    if (query.controller !== undefined) {
      validateKVStoreController(query.controller)
    }
    if (
      query.tagQueryMode !== undefined &&
      query.tagQueryMode !== 'all' &&
      query.tagQueryMode !== 'any'
    ) {
      throw new Error('KVStore tag query mode is invalid')
    }
    if (
      query.limit !== undefined &&
      (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)
    ) {
      throw new Error('KVStore query limit is invalid')
    }
    if (
      query.skip !== undefined &&
      (!Number.isSafeInteger(query.skip) || query.skip < 0 || query.skip > 100000)
    ) {
      throw new Error('KVStore query skip is invalid')
    }
    if (query.sortOrder !== undefined && query.sortOrder !== 'asc' && query.sortOrder !== 'desc') {
      throw new Error('KVStore query sort order is invalid')
    }
    const hasSelector =
      (typeof query.key === 'string' && query.key.length > 0) ||
      (typeof query.controller === 'string' && query.controller.length > 0) ||
      (Array.isArray(query.protocolID) && query.protocolID.length === 2) ||
      (Array.isArray(query.tags) && query.tags.length > 0)

    if (!hasSelector) {
      throw new Error('Must specify at least one selector: key, controller, protocolID, or tags')
    }
  }

  /**
   * Sets a key-value pair. The current user (wallet identity) becomes the controller.
   *
   * @param {string} key - The key to set (user computes this however they want)
   * @param {string} value - The value to store
   * @param {KVStoreSetOptions} [options={}] - Configuration options for the set operation
   * @returns {Promise<OutpointString>} The outpoint of the created token
   */
  async set(key: string, value: string, options: KVStoreSetOptions = {}): Promise<OutpointString> {
    validateKVStoreKey(key)
    validateKVStoreValue(value)

    const protocolID = validateKVStoreProtocol(options.protocolID ?? this.config.protocolID)
    const tokenSetDescription =
      options.tokenSetDescription != null && options.tokenSetDescription !== ''
        ? options.tokenSetDescription
        : `Create KVStore value for ${key}`
    const tokenUpdateDescription =
      options.tokenUpdateDescription != null && options.tokenUpdateDescription !== ''
        ? options.tokenUpdateDescription
        : `Update KVStore value for ${key}`
    const tokenAmount = options.tokenAmount ?? this.config.tokenAmount
    if (
      !Number.isSafeInteger(tokenAmount) ||
      (tokenAmount as number) < 0 ||
      (tokenAmount as number) > 21e14
    ) {
      throw new Error('KVStore token amount is invalid')
    }
    const tags = validateKVStoreTags(options.tags) ?? []
    const controller = await this.getIdentityKey()
    const lockQueue = await this.queueOperationOnKey(key)

    try {
      // Create PushDrop locking script (reusable across retries)
      const pushdrop = new PushDrop(this.wallet, this.config.originator)
      const lockingScriptFields = [
        toArray(JSON.stringify(protocolID), 'utf8'),
        toArray(key, 'utf8'),
        toArray(value, 'utf8'),
        toArray(controller, 'hex')
      ]

      // Add tags as optional 5th field for backwards compatibility
      if (tags.length > 0) {
        lockingScriptFields.push(toArray(JSON.stringify(tags), 'utf8'))
      }

      const lockingScript = await pushdrop.lock(
        lockingScriptFields,
        protocolID,
        key,
        'anyone',
        true
      )

      // Wrap entire operation in double-spend retry, including overlay query
      const outpoint = await withDoubleSpendRetry(async () => {
        // Re-query overlay on each attempt to get fresh token state
        const existingEntries = await this.queryOverlay(
          { key, controller, protocolID },
          { includeToken: true }
        )
        const existingTokens = existingEntries.flatMap(entry =>
          entry.token == null ? [] : [entry.token]
        )

        if (existingTokens.length === 0) {
          // Create new token
          const transaction = await completeBoundAction(
            this.wallet,
            {
              description: tokenSetDescription,
              outputs: [
                {
                  satoshis: tokenAmount ?? (this.config.tokenAmount as number),
                  lockingScript: lockingScript.toHex(),
                  outputDescription: 'KVStore token'
                }
              ],
              options: {
                acceptDelayedBroadcast: this.config.acceptDelayedBroadcast,
                noSend: this.config.overlayBroadcast,
                randomizeOutputs: false
              }
            },
            {},
            this.config.originator
          )
          await this.submitToOverlay(transaction)
          return this.#findTokenOutpoint(transaction, tokenAmount as number, lockingScript.toHex())
        } else {
          // Update and collapse every authenticated current token for this exact namespace.
          const inputs: CreateActionInput[] = existingTokens.map(existingToken => ({
            outpoint: `${existingToken.txid}.${existingToken.outputIndex}` as OutpointString,
            unlockingScriptLength: 74,
            inputDescription: 'Previous KVStore token'
          }))
          const inputBEEF = new Beef()
          for (const existingToken of existingTokens) inputBEEF.mergeBeef(existingToken.beef)
          const pushdropSigners = Object.fromEntries(
            existingTokens.map(existingToken => {
              const outpoint = `${existingToken.txid}.${existingToken.outputIndex}`
              const unlocker = pushdrop.unlock(
                protocolID,
                key,
                'anyone',
                'all',
                false,
                existingToken.satoshis,
                existingToken.lockingScript
              )
              return [
                outpoint,
                async (tx: Transaction, inputIndex: number) => await unlocker.sign(tx, inputIndex)
              ]
            })
          )
          const transaction = await completeBoundAction(
            this.wallet,
            {
              description: tokenUpdateDescription,
              inputBEEF: inputBEEF.toBinary(),
              inputs,
              outputs: [
                {
                  satoshis: tokenAmount ?? (this.config.tokenAmount as number),
                  lockingScript: lockingScript.toHex(),
                  outputDescription: 'KVStore token'
                }
              ],
              options: {
                acceptDelayedBroadcast: this.config.acceptDelayedBroadcast,
                noSend: this.config.overlayBroadcast,
                randomizeOutputs: false
              }
            },
            { inputSigners: pushdropSigners },
            this.config.originator
          )
          await this.submitToOverlay(transaction)
          return this.#findTokenOutpoint(transaction, tokenAmount as number, lockingScript.toHex())
        }
      }, this.topicBroadcaster)

      return outpoint
    } finally {
      if (lockQueue.length > 0) {
        this.finishOperationOnKey(key, lockQueue)
      }
    }
  }

  /**
   * Removes the key-value pair associated with the given key from the overlay service.
   *
   * @param {string} key - The key to remove.
   * @param {CreateActionOutput[] | undefined} [outputs=undefined] - Additional outputs to include in the removal transaction.
   * @param {KVStoreRemoveOptions} [options=undefined] - Optional parameters for the removal operation.
   * @returns {Promise<HexString>} A promise that resolves to the txid of the removal transaction if successful.
   * @throws {Error} If the key is invalid.
   * @throws {Error} If the key does not exist in the store.
   * @throws {Error} If the overlay service is unreachable or the transaction fails.
   * @throws {Error} If there are existing tokens that cannot be unlocked.
   */
  async remove(
    key: string,
    outputs?: CreateActionOutput[],
    options: KVStoreRemoveOptions = {}
  ): Promise<HexString> {
    validateKVStoreKey(key)

    const protocolID = validateKVStoreProtocol(options.protocolID ?? this.config.protocolID)
    const tokenRemovalDescription =
      options.tokenRemovalDescription != null && options.tokenRemovalDescription !== ''
        ? options.tokenRemovalDescription
        : `Remove KVStore value for ${key}`
    const controller = await this.getIdentityKey()
    const lockQueue = await this.queueOperationOnKey(key)

    try {
      const pushdrop = new PushDrop(this.wallet, this.config.originator)

      // Remove token with double-spend retry
      const txid = await withDoubleSpendRetry(async () => {
        // Re-query overlay on each attempt to get fresh token state
        const existingEntries = await this.queryOverlay(
          { key, controller, protocolID },
          { includeToken: true }
        )

        if (existingEntries.length === 0 || existingEntries[0].token == null) {
          throw new Error('The item did not exist, no item was deleted.')
        }

        const existingTokens = existingEntries.flatMap(entry =>
          entry.token == null ? [] : [entry.token]
        )
        const inputs: CreateActionInput[] = existingTokens.map(existingToken => ({
          outpoint: `${existingToken.txid}.${existingToken.outputIndex}` as OutpointString,
          unlockingScriptLength: 74,
          inputDescription: 'KVStore token to remove'
        }))
        const inputBEEF = new Beef()
        for (const existingToken of existingTokens) inputBEEF.mergeBeef(existingToken.beef)
        const inputSigners = Object.fromEntries(
          existingTokens.map(existingToken => {
            const outpoint = `${existingToken.txid}.${existingToken.outputIndex}`
            const unlocker = pushdrop.unlock(
              protocolID,
              key,
              'anyone',
              'all',
              false,
              existingToken.satoshis,
              existingToken.lockingScript
            )
            return [
              outpoint,
              async (tx: Transaction, inputIndex: number) => await unlocker.sign(tx, inputIndex)
            ]
          })
        )
        const transaction = await completeBoundAction(
          this.wallet,
          {
            description: tokenRemovalDescription,
            inputBEEF: inputBEEF.toBinary(),
            inputs,
            outputs,
            options: {
              acceptDelayedBroadcast: this.config.acceptDelayedBroadcast,
              randomizeOutputs: false,
              noSend: this.config.overlayBroadcast
            }
          },
          { inputSigners },
          this.config.originator
        )
        await this.submitToOverlay(transaction)
        return transaction.id('hex')
      }, this.topicBroadcaster)

      return txid
    } finally {
      if (lockQueue.length > 0) {
        this.finishOperationOnKey(key, lockQueue)
      }
    }
  }

  /**
   * Queues an operation on a specific key to ensure atomic updates.
   * Prevents concurrent operations on the same key from interfering with each other.
   *
   * @param {string} key - The key to queue an operation for.
   * @returns {Promise<Array<(value: void | PromiseLike<void>) => void>>} The lock queue for cleanup.
   * @private
   */
  private async queueOperationOnKey(
    key: string
  ): Promise<Array<(value: void | PromiseLike<void>) => void>> {
    // Check if a lock exists for this key and wait for it to resolve
    let lockQueue = this.keyLocks.get(key)
    if (lockQueue == null) {
      lockQueue = []
      this.keyLocks.set(key, lockQueue)
    }

    let resolveNewLock: () => void = () => {}
    const newLock = new Promise<void>(resolve => {
      resolveNewLock = resolve
      if (lockQueue != null) {
        lockQueue.push(resolve)
      }
    })

    // If we are the only request, resolve the lock immediately, queue remains at 1 item until request ends.
    if (lockQueue.length === 1) {
      resolveNewLock()
    }

    await newLock
    return lockQueue
  }

  /**
   * Finishes an operation on a key and resolves the next waiting operation.
   *
   * @param {string} key - The key to finish the operation for.
   * @param {Array<(value: void | PromiseLike<void>) => void>} lockQueue - The lock queue from queueOperationOnKey.
   * @private
   */
  private finishOperationOnKey(
    key: string,
    lockQueue: Array<(value: void | PromiseLike<void>) => void>
  ): void {
    lockQueue.shift() // Remove the current lock from the queue
    if (lockQueue.length > 0) {
      // If there are more locks waiting, resolve the next one
      lockQueue[0]()
    } else {
      // Clean up empty queue to prevent memory leak
      this.keyLocks.delete(key)
    }
  }

  /**
   * Helper function to fetch and cache user identity key
   *
   * @returns {Promise<PubKeyHex>} The identity key of the current user
   * @private
   */
  private async getIdentityKey(): Promise<PubKeyHex> {
    if (this.cachedIdentityKey == null) {
      const result = await this.wallet.getPublicKey({ identityKey: true }, this.config.originator)
      try {
        this.cachedIdentityKey = validateKVStoreController(result?.publicKey)
      } catch {
        throw new Error('Wallet returned an invalid identity key')
      }
    }
    return this.cachedIdentityKey
  }

  /**
   * Queries the overlay service for KV entries.
   *
   * @param {KVStoreQuery} query - Query parameters sent to overlay
   * @param {KVStoreGetOptions} options - Configuration options for the query
   * @returns {Promise<KVStoreEntry[]>} Array of matching KV entries
   * @private
   */
  private async queryOverlay(
    query: KVStoreQuery,
    options: KVStoreGetOptions = {}
  ): Promise<KVStoreEntry[]> {
    const answer = await this.lookupResolver.query({
      service: options.serviceName ?? (this.config.serviceName as string),
      query
    })

    if (answer.type !== 'output-list' || answer.outputs.length === 0) {
      return []
    }

    const entries: KVStoreEntry[] = []

    if (answer.outputs.length > 1000) throw new Error('KVStore lookup returned too many outputs')
    for (const result of answer.outputs) {
      const entry = await this.#decodeOverlayEntry(result, options)
      if (entry != null && this.#entryMatchesQuery(entry, query)) entries.push(entry)
    }

    return entries
  }

  async #decodeOverlayEntry(
    result: LookupAnswer['outputs'][number],
    options: KVStoreGetOptions
  ): Promise<KVStoreEntry | undefined> {
    try {
      const beef = Beef.fromBinaryStrict(result.beef)
      const txid = result.txid ?? beef.atomicTxid ?? beef.txs.at(-1)?.txid
      if (txid == null || !/^[0-9a-f]{64}$/i.test(txid)) return undefined
      const tx = beef.findTxid(txid)?.tx
      if (tx == null || tx.id('hex').toLowerCase() !== txid.toLowerCase()) return undefined
      if (!Number.isSafeInteger(result.outputIndex) || result.outputIndex < 0) return undefined
      const output = tx.outputs[result.outputIndex]
      const outputSatoshis = output?.satoshis
      if (
        output?.lockingScript == null ||
        typeof outputSatoshis !== 'number' ||
        !Number.isSafeInteger(outputSatoshis) ||
        outputSatoshis < 0
      )
        return undefined
      const decoded = await decodeAndVerifyKVStoreToken(output.lockingScript)

      const entry: KVStoreEntry = {
        key: decoded.key,
        value: decoded.value,
        controller: decoded.controller,
        protocolID: decoded.protocolID,
        tags: decoded.tags
      }
      if (options.includeToken === true) {
        entry.token = {
          txid,
          outputIndex: result.outputIndex,
          beef,
          satoshis: outputSatoshis,
          lockingScript: output.lockingScript
        }
      }
      if (options.history === true) {
        entry.history = await this.#historian.buildHistory(
          tx,
          {
            key: entry.key,
            protocolID: entry.protocolID,
            controller: entry.controller
          },
          result.outputIndex
        )
      }
      return entry
    } catch {
      // Skip malformed or undecodable outputs rather than failing the entire query.
      return undefined
    }
  }

  #entryMatchesQuery(entry: KVStoreEntry, query: KVStoreQuery): boolean {
    if (query.key !== undefined && entry.key !== query.key) return false
    if (
      query.controller !== undefined &&
      entry.controller.toLowerCase() !== query.controller.toLowerCase()
    )
      return false
    if (
      query.protocolID !== undefined &&
      JSON.stringify(entry.protocolID) !== JSON.stringify(query.protocolID)
    )
      return false
    if (query.tags !== undefined) {
      const present = new Set(entry.tags ?? [])
      const matches = query.tags.map(tag => present.has(tag))
      if (
        (query.tagQueryMode ?? 'all') === 'all'
          ? matches.some(match => !match)
          : matches.every(match => !match)
      )
        return false
    }
    return true
  }

  #findTokenOutpoint(
    transaction: Transaction,
    satoshis: number,
    lockingScript: string
  ): OutpointString {
    const indexes = transaction.outputs.flatMap((output, index) =>
      output.satoshis === satoshis && output.lockingScript.toHex() === lockingScript ? [index] : []
    )
    if (indexes.length !== 1)
      throw new Error('Final transaction does not contain one unique KVStore token')
    return `${transaction.id('hex')}.${indexes[0]}` as OutpointString
  }

  /**
   * Submits a transaction to an overlay service using TopicBroadcaster.
   * Broadcasts the transaction to the configured topics for network propagation.
   *
   * @param {Transaction} transaction - The transaction to broadcast.
   * @returns {Promise<BroadcastResponse | BroadcastFailure>} The broadcast result.
   * @throws {Error} If the broadcast fails or the network is unreachable.
   * @private
   */
  private async submitToOverlay(
    transaction: Transaction
  ): Promise<BroadcastResponse | BroadcastFailure> {
    const result = await this.topicBroadcaster.broadcast(transaction)
    if (isBroadcastFailure(result)) {
      throw new Error(`KVStore overlay rejected transaction: ${result.code}: ${result.description}`)
    }
    if (result.txid.toLowerCase() !== transaction.id('hex').toLowerCase()) {
      throw new Error('KVStore overlay acknowledged a different transaction')
    }
    return result
  }
}

export default GlobalKVStore
