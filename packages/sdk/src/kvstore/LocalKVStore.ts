import LockingScript from '../script/LockingScript.js'
import PushDrop from '../script/templates/PushDrop.js'
import { decodeCanonicalPushDrop } from '../script/templates/PushDropValidation.js'
import { toArray, toUTF8Strict } from '../primitives/utils.js'
import {
  WalletInterface,
  OutpointString,
  CreateActionInput,
  WalletProtocol,
  ListOutputsResult,
  WalletOutput
} from '../wallet/Wallet.interfaces.js'
import WalletClient from '../wallet/WalletClient.js'
import Transaction from '../transaction/Transaction.js'
import { Beef } from '../transaction/Beef.js'
import PublicKey from '../primitives/PublicKey.js'
import { completeBoundAction } from '../wallet/completeBoundAction.js'
import { assertSafeWalletValue } from '../wallet/WalletResultValidation.js'
import { validateKVStoreKey, validateKVStoreValue } from './kvStoreTokenValidation.js'

const MAX_LOCAL_TOKEN_BYTES = 2 * 1024 * 1024
const MAX_LOCAL_BEEF_BYTES = 256 * 1024 * 1024
const MAX_LOCAL_OUTPUTS = 10000

interface AuthenticatedLocalOutput {
  outpoint: OutpointString
  output: WalletOutput
  lockingScript: LockingScript
  valueField: number[]
}

function canonicalOutpoint(value: unknown): OutpointString {
  if (typeof value !== 'string') throw new Error('Wallet output has an invalid outpoint')
  const match = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/i.exec(value)
  if (match == null || Number(match[2]) > 0xffffffff) {
    throw new Error('Wallet output has an invalid outpoint')
  }
  return `${match[1].toLowerCase()}.${Number(match[2])}` as OutpointString
}

function boundedBytes(value: unknown, label: string, maximum: number): number[] | Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length === 0 || value.length > maximum) throw new Error(`${label} is invalid`)
    return value
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is invalid`)
  }
  for (let index = 0; index < value.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      !Number.isInteger(value[index]) ||
      value[index] < 0 ||
      value[index] > 255
    ) {
      throw new Error(`${label} is invalid`)
    }
  }
  return value as number[]
}

/**
 * Implements a key-value storage system backed by transaction outputs managed by a wallet.
 * Each key-value pair is represented by a PushDrop token output in a specific context (basket).
 * Allows setting, getting, and removing key-value pairs, with optional encryption.
 */
export default class LocalKVStore {
  /**
   * The wallet interface used to manage outputs and perform cryptographic operations.
   * @private
   * @readonly
   */
  private readonly wallet: WalletInterface
  /**
   * The context (basket name) used to namespace the key-value pairs within the wallet.
   * @private
   * @readonly
   */
  private readonly context: string
  /**
   * Flag indicating whether values should be encrypted before storing.
   * @private
   * @readonly
   */
  private readonly encrypt: boolean

  /**
   * An originator to use with PushDrop and the wallet.
   * @private
   * @readonly
   */
  private readonly originator?: string

  acceptDelayedBroadcast: boolean = false

  /**
   * A map to store locks for each key to ensure atomic updates.
   * @private
   */
  private readonly keyLocks: Map<string, Array<(value: void | PromiseLike<void>) => void>> =
    new Map()

  /**
   * Creates an instance of the localKVStore.
   *
   * @param {WalletInterface} [wallet=new WalletClient()] - The wallet interface to use. Defaults to a new WalletClient instance.
   * @param {string} [context='kvstoredefault'] - The context (basket) for namespacing keys. Defaults to 'kvstore default'.
   * @param {boolean} [encrypt=true] - Whether to encrypt values. Defaults to true.
   * @param {string} [originator] — An originator to use with PushDrop and the wallet, if provided.
   * @throws {Error} If the context is missing or empty.
   */
  constructor(
    wallet: WalletInterface = new WalletClient(),
    context = 'kvstore default',
    encrypt = true,
    originator?: string,
    acceptDelayedBroadcast = false
  ) {
    const contextBytes = typeof context === 'string' ? toArray(context, 'utf8').length : 0
    if (typeof context !== 'string' || contextBytes < 5 || contextBytes > 300) {
      throw new Error('A context of 5–300 UTF-8 bytes is required.')
    }
    this.wallet = wallet
    this.context = context
    this.encrypt = encrypt
    this.originator = originator
    this.acceptDelayedBroadcast = acceptDelayedBroadcast
  }

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

  private finishOperationOnKey(
    key: string,
    lockQueue: Array<(value: void | PromiseLike<void>) => void>
  ): void {
    lockQueue.shift() // Remove the current lock from the queue
    if (lockQueue.length > 0) {
      // If there are more locks waiting, resolve the next one
      lockQueue[0]()
    } else {
      this.keyLocks.delete(key)
    }
  }

  private getProtocol(key: string): { protocolID: WalletProtocol; keyID: string } {
    return { protocolID: [2, this.context], keyID: key }
  }

  private async getOutputs(key: string, limit?: number): Promise<ListOutputsResult> {
    validateKVStoreKey(key)
    const results = assertSafeWalletValue(
      await this.wallet.listOutputs(
        {
          basket: this.context,
          tags: [key],
          tagQueryMode: 'all',
          include: 'entire transactions',
          limit
        },
        this.originator
      ),
      'listOutputs'
    )
    if (
      results == null ||
      !Array.isArray(results.outputs) ||
      !Number.isSafeInteger(results.totalOutputs) ||
      results.totalOutputs < results.outputs.length ||
      results.totalOutputs > MAX_LOCAL_OUTPUTS ||
      results.outputs.length > MAX_LOCAL_OUTPUTS
    ) {
      throw new Error('Wallet returned an invalid KVStore output list')
    }
    if (results.outputs.length > 0) {
      boundedBytes(results.BEEF, 'Wallet KVStore BEEF', MAX_LOCAL_BEEF_BYTES)
    }
    return results
  }

  /**
   * Retrieves the value associated with a given key.
   *
   * @param {string} key - The key to retrieve the value for.
   * @param {string | undefined} [defaultValue=undefined] - The value to return if the key is not found.
   * @returns {Promise<string | undefined>} A promise that resolves to the value as a string,
   *   the defaultValue if the key is not found, or undefined if no defaultValue is provided.
   * @throws {Error} If too many outputs are found for the key (ambiguous state).
   * @throws {Error} If the found output's locking script cannot be decoded or represents an invalid token format.
   */
  async get(
    key: string,
    defaultValue: string | undefined = undefined
  ): Promise<string | undefined> {
    validateKVStoreKey(key)
    const lockQueue = await this.queueOperationOnKey(key)

    try {
      const r = await this.lookupValue(key, defaultValue, 5, false)
      return r.value
    } finally {
      this.finishOperationOnKey(key, lockQueue)
    }
  }

  private async authenticateOutputs(
    key: string,
    result: ListOutputsResult
  ): Promise<AuthenticatedLocalOutput[]> {
    if (result.outputs.length === 0) return []
    const encodedBEEF = boundedBytes(result.BEEF, 'Wallet KVStore BEEF', MAX_LOCAL_BEEF_BYTES)
    const beef = Beef.fromBinaryStrict(encodedBEEF)
    const protocol = this.getProtocol(key)
    const keyResult = assertSafeWalletValue(
      await this.wallet.getPublicKey({ ...protocol, counterparty: 'self' }, this.originator),
      'getPublicKey'
    )
    if (keyResult == null || typeof keyResult.publicKey !== 'string') {
      throw new Error('Wallet returned an invalid KVStore locking key')
    }
    const expectedLockingKey = PublicKey.fromString(keyResult.publicKey).toString()
    const seen = new Set<string>()
    const authenticated: AuthenticatedLocalOutput[] = []

    for (const output of result.outputs) {
      const outpoint = canonicalOutpoint(output?.outpoint)
      if (seen.has(outpoint)) throw new Error('Wallet returned a duplicate KVStore output')
      seen.add(outpoint)
      if (
        typeof output.spendable !== 'boolean' ||
        output.spendable !== true ||
        !Number.isSafeInteger(output.satoshis) ||
        output.satoshis < 0 ||
        output.satoshis > 21e14
      ) {
        throw new Error('Wallet returned invalid KVStore output metadata')
      }
      const [txid, outputIndexText] = outpoint.split('.')
      const transaction = beef.findTxid(txid)?.tx
      const outputIndex = Number(outputIndexText)
      if (transaction == null || transaction.id('hex').toLowerCase() !== txid) {
        throw new Error('KVStore BEEF does not contain the exact listed transaction')
      }
      const sourceOutput = transaction.outputs[outputIndex]
      if (
        sourceOutput?.lockingScript == null ||
        sourceOutput.satoshis !== output.satoshis ||
        (output.lockingScript !== undefined &&
          sourceOutput.lockingScript.toHex().toLowerCase() !== output.lockingScript.toLowerCase())
      ) {
        throw new Error('KVStore BEEF does not match the listed output')
      }
      const decoded = decodeCanonicalPushDrop(sourceOutput.lockingScript, {
        fieldCount: 2,
        maximumFieldBytes: MAX_LOCAL_TOKEN_BYTES,
        maximumPayloadBytes: MAX_LOCAL_TOKEN_BYTES + 1024
      })
      if (decoded.lockingPublicKey.toString() !== expectedLockingKey) {
        throw new Error('KVStore token locking key does not belong to the wallet')
      }
      const signatureResult = assertSafeWalletValue(
        await this.wallet.verifySignature(
          {
            data: decoded.fields[0],
            signature: decoded.fields[1],
            ...protocol,
            counterparty: 'self'
          },
          this.originator
        ),
        'verifySignature'
      )
      if (signatureResult?.valid !== true) throw new Error('KVStore token signature is invalid')
      authenticated.push({
        outpoint,
        output,
        lockingScript: sourceOutput.lockingScript,
        valueField: decoded.fields[0]
      })
    }
    return authenticated
  }

  private async lookupValue(
    key: string,
    defaultValue: string | undefined,
    limit?: number,
    allowMultiple = false
  ): Promise<LookupValueResult> {
    let lor: ListOutputsResult
    try {
      lor = await this.getOutputs(key, limit)
    } catch (error) {
      throw new Error(
        `Invalid value found. Relinquish the corrupted output from the ${this.context} basket before using this key again. Original error: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const r: LookupValueResult = {
      value: defaultValue,
      outpoint: undefined,
      lor,
      authenticated: []
    }
    if (lor.outputs.length === 0) {
      return r
    }
    if (!allowMultiple && (lor.outputs.length !== 1 || lor.totalOutputs !== 1)) {
      throw new Error(
        'Multiple KVStore outputs make the current value ambiguous; call set to collapse them'
      )
    }
    if (allowMultiple && lor.outputs.length !== lor.totalOutputs) {
      throw new Error('Wallet did not return every KVStore output needed for an atomic collapse')
    }
    try {
      r.authenticated = await this.authenticateOutputs(key, lor)
    } catch (error) {
      throw new Error(
        `Invalid value found. Relinquish the corrupted output from the ${this.context} basket before using this key again. Original error: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const selected = r.authenticated.at(-1)
    if (selected == null) return r
    r.outpoint = selected.outpoint
    if (this.encrypt) {
      const decryptResult = assertSafeWalletValue(
        await this.wallet.decrypt(
          {
            ...this.getProtocol(key),
            ciphertext: selected.valueField
          },
          this.originator
        ),
        'decrypt'
      )
      const plaintext = boundedBytes(
        decryptResult?.plaintext,
        'Wallet KVStore plaintext',
        MAX_LOCAL_TOKEN_BYTES
      )
      r.value = validateKVStoreValue(toUTF8Strict(plaintext))
    } else {
      r.value = validateKVStoreValue(toUTF8Strict(selected.valueField))
    }
    return r
  }

  #getInputs(outputs: AuthenticatedLocalOutput[]): CreateActionInput[] {
    const inputs: CreateActionInput[] = []
    for (const output of outputs) {
      inputs.push({
        outpoint: output.outpoint,
        unlockingScriptLength: 74,
        inputDescription: 'Previous key-value token'
      })
    }
    return inputs
  }

  async #removeOutputs(
    key: string,
    outputs: AuthenticatedLocalOutput[],
    inputBEEF: number[] | Uint8Array | undefined,
    totalOutputs: number
  ): Promise<string> {
    const pushdrop = new PushDrop(this.wallet, this.originator)
    try {
      const inputs = this.#getInputs(outputs)
      const protocol = this.getProtocol(key)
      const inputSigners = Object.fromEntries(
        outputs.map(output => {
          const unlocker = pushdrop.unlock(
            protocol.protocolID,
            protocol.keyID,
            'self',
            'all',
            false,
            output.output.satoshis,
            output.lockingScript
          )
          return [
            output.outpoint,
            async (transaction: Transaction, inputIndex: number) =>
              await unlocker.sign(transaction, inputIndex)
          ]
        })
      )
      const transaction = await completeBoundAction(
        this.wallet,
        {
          description: `Remove ${key} in ${this.context}`,
          inputBEEF,
          inputs,
          options: {
            acceptDelayedBroadcast: this.acceptDelayedBroadcast
          }
        },
        { inputSigners },
        this.originator
      )
      return transaction.id('hex')
    } catch (error) {
      throw new Error(
        `There are ${totalOutputs} outputs with tag ${key} that cannot be unlocked. Original error: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Sets or updates the value associated with a given key atomically.
   * If the key already exists (one or more outputs found), it spends the existing output(s)
   * and creates a new one with the updated value. If multiple outputs exist for the key,
   * they are collapsed into a single new output.
   * If the key does not exist, it creates a new output.
   * Handles encryption if enabled.
   * If signing the update/collapse transaction fails, it relinquishes the original outputs and starts over with a new chain.
   * Ensures atomicity by locking the key during the operation, preventing concurrent updates
   * to the same key from missing earlier changes.
   *
   * @param {string} key - The key to set or update.
   * @param {string} value - The value to associate with the key.
   * @returns {Promise<OutpointString>} A promise that resolves to the outpoint string (txid.vout) of the new or updated token output.
   */
  async set(key: string, value: string): Promise<OutpointString> {
    validateKVStoreKey(key)
    validateKVStoreValue(value)
    const lockQueue = await this.queueOperationOnKey(key)

    try {
      const current = await this.lookupValue(key, undefined, MAX_LOCAL_OUTPUTS, true)
      if (current.value === value && current.authenticated.length === 1) {
        if (current.outpoint === undefined) {
          throw new Error('outpoint must be valid when value is valid and unchanged')
        }
        // Don't create a new transaction if the value doesn't need to change
        return current.outpoint
      }

      const protocol = this.getProtocol(key)
      let valueAsArray = toArray(value, 'utf8')
      if (this.encrypt) {
        const encryptResult = assertSafeWalletValue(
          await this.wallet.encrypt(
            {
              ...protocol,
              plaintext: valueAsArray
            },
            this.originator
          ),
          'encrypt'
        )
        valueAsArray = Array.from(
          boundedBytes(
            encryptResult?.ciphertext,
            'Wallet KVStore ciphertext',
            MAX_LOCAL_TOKEN_BYTES
          )
        )
      }

      const pushdrop = new PushDrop(this.wallet, this.originator)
      const lockingScript = await pushdrop.lock(
        [valueAsArray],
        protocol.protocolID,
        protocol.keyID,
        'self'
      )

      const { BEEF: inputBEEF } = current.lor
      try {
        const inputs = this.#getInputs(current.authenticated)
        const inputSigners = Object.fromEntries(
          current.authenticated.map(output => {
            const unlocker = pushdrop.unlock(
              protocol.protocolID,
              protocol.keyID,
              'self',
              'all',
              false,
              output.output.satoshis,
              output.lockingScript
            )
            return [
              output.outpoint,
              async (transaction: Transaction, inputIndex: number) =>
                await unlocker.sign(transaction, inputIndex)
            ]
          })
        )
        const transaction = await completeBoundAction(
          this.wallet,
          {
            description: `Update ${key} in ${this.context}`,
            inputBEEF,
            inputs,
            outputs: [
              {
                basket: this.context,
                tags: [key],
                lockingScript: lockingScript.toHex(),
                satoshis: 1,
                outputDescription: 'Key-value token'
              }
            ],
            options: {
              acceptDelayedBroadcast: this.acceptDelayedBroadcast,
              randomizeOutputs: false
            }
          },
          { inputSigners },
          this.originator
        )
        const indexes = transaction.outputs.flatMap((output, index) =>
          output.satoshis === 1 && output.lockingScript.toHex() === lockingScript.toHex()
            ? [index]
            : []
        )
        if (indexes.length !== 1) {
          throw new Error('Final transaction does not contain one unique KVStore token')
        }
        return `${transaction.id('hex')}.${indexes[0]}` as OutpointString
      } catch (error) {
        throw new Error(
          `There are ${current.authenticated.length} outputs with tag ${key} that cannot be unlocked. Original error: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } finally {
      this.finishOperationOnKey(key, lockQueue)
    }
  }

  /**
   * Removes the key-value pair associated with the given key.
   * It finds the existing output(s) for the key and spends them without creating a new output.
   * If multiple outputs exist, they are all spent in the same transaction.
   * If the key does not exist, it does nothing.
   * If signing the removal transaction fails, it relinquishes the original outputs instead of spending.
   *
   * @param {string} key - The key to remove.
   * @returns {Promise<string[]>} A promise that resolves to the txids of the removal transactions if successful.
   */
  async remove(key: string): Promise<string[]> {
    validateKVStoreKey(key)
    const lockQueue = await this.queueOperationOnKey(key)

    try {
      const txids: string[] = []
      const consumed = new Set<string>()
      for (;;) {
        const result = await this.getOutputs(key, MAX_LOCAL_OUTPUTS)
        const { outputs, BEEF: inputBEEF, totalOutputs } = result
        if (outputs.length > 0) {
          const authenticated = await this.authenticateOutputs(key, result)
          for (const output of authenticated) {
            if (consumed.has(output.outpoint)) {
              throw new Error('Wallet repeated a KVStore output after it was removed')
            }
            consumed.add(output.outpoint)
          }
          txids.push(await this.#removeOutputs(key, authenticated, inputBEEF, totalOutputs))
        }
        if (outputs.length === totalOutputs) {
          break
        }
      }
      return txids
    } finally {
      this.finishOperationOnKey(key, lockQueue)
    }
  }
}

interface LookupValueResult {
  value: string | undefined
  outpoint: OutpointString | undefined
  lor: ListOutputsResult
  authenticated: AuthenticatedLocalOutput[]
}
