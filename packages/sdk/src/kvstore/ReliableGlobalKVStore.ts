import { PushDrop } from '../script/index.js'
import * as Utils from '../primitives/utils.js'
import { ReliableTopicBroadcaster } from '../overlay-tools/ReliableTopicBroadcaster.js'
import GlobalKVStore from './GlobalKVStore.js'
import ReliableLookupResolver from '../overlay-tools/ReliableLookupResolver.js'
import { withinDeadline } from '../overlay-tools/ReliableLookup.js'
import {
  validateKVAnswer,
  reconcileKVResults,
  KVStoreUnavailableError,
  KVStoreWriteError,
  confirmKVWrite,
  type KVStoreReliabilityConfig,
  type KVStoreReadResult
} from './ReliableKVStore.js'
import { withKVWriteLock } from './withKVWriteLock.js'
import type {
  KVStoreConfig,
  KVStoreQuery,
  KVStoreGetOptions,
  KVStoreEntry,
  KVStoreSetOptions,
  KVStoreRemoveOptions
} from './types.js'
import type { CreateActionOutput, WalletProtocol } from '../wallet/Wallet.interfaces.js'
import type Transaction from '../transaction/Transaction.js'

export interface ReliableKVStoreConfig extends Omit<KVStoreConfig, 'lookupResolver'> {
  lookupResolver?: ReliableLookupResolver
  reliability: KVStoreReliabilityConfig
}
interface PendingWrite {
  txid: string
  removing: boolean
  transaction?: Transaction
}
const pendingWrites = new Map<string, PendingWrite>()
const failedTransactions = new WeakMap<KVStoreWriteError, Transaction>()

/** Opt-in adapter available only at @bsv/sdk/kvstore/reliable. */
export default class ReliableGlobalKVStore extends GlobalKVStore {
  private readonly reliableResolver: ReliableLookupResolver
  private readonly policy: KVStoreReliabilityConfig

  constructor(config: ReliableKVStoreConfig) {
    if (
      typeof config.reliability?.chainTracker?.isValidRootForHeight !== 'function' ||
      typeof config.reliability.chainTracker.currentHeight !== 'function'
    )
      throw new TypeError('Reliable reads require an explicit chain tracker')
    const resolver =
      config.lookupResolver ??
      new ReliableLookupResolver({
        networkPreset: config.networkPreset,
        hostOverrides: config.hostOverrides,
        slapTrackers: config.slapTrackers
      })
    super({
      ...config,
      overlayBroadcast: config.overlayBroadcast ?? true,
      lookupResolver: resolver
    })
    this.reliableResolver = resolver
    this.policy = config.reliability
    // The same checked path covers submission and the SDK's competing-tx recovery.
    const broadcaster = new ReliableTopicBroadcaster(
      this.config.topics ?? ['tm_kvstore'],
      resolver,
      this.config.networkPreset === 'local'
    )
    const broadcast = broadcaster.broadcast.bind(broadcaster)
    this.topicBroadcaster.broadcast = async transaction => {
      let result
      try {
        result = await withinDeadline(async () => await broadcast(transaction), 5000)
      } catch {
        throw this.submissionError('unconfirmed', transaction)
      }
      if (result.status !== 'success') throw this.submissionError('rejected', transaction)
      await this.confirmAdmittedOutput(transaction)
      return result
    }
  }

  private submissionError(
    outcome: 'rejected' | 'unconfirmed',
    transaction: Transaction
  ): KVStoreWriteError {
    const error = new KVStoreWriteError(outcome, transaction.id('hex'))
    failedTransactions.set(error, transaction)
    return error
  }

  /** GlobalKVStore places its token at output zero, including competing replacements. */
  private async confirmAdmittedOutput(transaction: Transaction): Promise<void> {
    let query: KVStoreQuery
    try {
      const decoded = PushDrop.decode(transaction.outputs[0].lockingScript)
      if (decoded.fields.length !== 5 && decoded.fields.length !== 6) return
      query = {
        protocolID: JSON.parse(Utils.toUTF8(decoded.fields[0])),
        key: Utils.toUTF8(decoded.fields[1]),
        controller: Utils.toHex(decoded.fields[3])
      }
    } catch {
      return
    } // A removal may have no replacement token.
    const outpoint = `${transaction.id('hex')}.0`
    const confirmed = await confirmKVWrite(
      async signal => await this.getResult(query, {}, signal),
      outpoint
    )
    if (!confirmed) throw this.submissionError('unconfirmed', transaction)
  }

  async getResult(
    query: KVStoreQuery,
    options: KVStoreGetOptions = {},
    signal?: AbortSignal
  ): Promise<KVStoreReadResult> {
    if (options.history === true)
      throw new Error('Verified history requires a separate history validation policy')
    if (!query.key && !query.controller && !query.protocolID && !query.tags?.length)
      throw new Error('A KVStore query selector is required')
    const resolution = await this.reliableResolver.queryReliable(
      { service: options.serviceName ?? this.config.serviceName ?? 'ls_kvstore', query },
      {
        signal,
        deadlineMs: this.policy.deadlineMs,
        hostTimeoutMs: this.policy.hostTimeoutMs,
        validate: async (answer, signal) =>
          await validateKVAnswer(answer, query, this.policy.chainTracker, signal)
      }
    )
    return reconcileKVResults(resolution, this.policy.authoritativeHosts)
  }

  private async readEntries(
    query: KVStoreQuery,
    options: KVStoreGetOptions
  ): Promise<KVStoreEntry[]> {
    const result = await this.getResult(query, options)
    if (result.kind === 'absent') return []
    if (result.kind !== 'data' || result.completeness !== 'complete')
      throw new KVStoreUnavailableError(result.kind)
    return result.entries.map(entry => {
      if (options.includeToken === true) return entry
      const { token: _token, ...value } = entry
      return value
    })
  }

  override async get(
    query: KVStoreQuery,
    options: KVStoreGetOptions = {}
  ): Promise<KVStoreEntry | KVStoreEntry[] | undefined> {
    const entries = await this.readEntries(query, options)
    return query.key !== undefined && query.controller !== undefined ? entries[0] : entries
  }

  protected override async queryOverlay(
    query: KVStoreQuery,
    options: KVStoreGetOptions = {},
    writeProtocol?: WalletProtocol
  ): Promise<KVStoreEntry[]> {
    return await this.readEntries(
      { ...query, protocolID: writeProtocol ?? query.protocolID ?? this.config.protocolID },
      options
    )
  }

  // Keep the returned-error check even if an application replaces the broadcaster.
  protected override async submitToOverlay(transaction: Transaction) {
    const result = await super.submitToOverlay(transaction)
    if (result.status !== 'success') throw this.submissionError('rejected', transaction)
    return result
  }

  private async write<T>(
    key: string,
    protocol: WalletProtocol | undefined,
    operation: (controller: string) => Promise<T>,
    removing = false
  ): Promise<T> {
    const controller = await this.getIdentityKey()
    const scope = JSON.stringify([
      this.config.networkPreset,
      this.config.serviceName,
      protocol ?? this.config.protocolID,
      controller,
      key
    ])
    return await withKVWriteLock(scope, async () => {
      const pending = pendingWrites.get(scope)
      if (pending !== undefined) throw new KVStoreWriteError('unconfirmed', pending.txid)
      if (pendingWrites.size >= 256) throw new KVStoreUnavailableError('unavailable')
      try {
        return await operation(controller)
      } catch (error) {
        if (error instanceof KVStoreWriteError)
          pendingWrites.set(scope, {
            txid: error.txid,
            removing,
            transaction: failedTransactions.get(error)
          })
        throw error
      }
    })
  }

  /** Reconcile a pending write without creating another transaction. Memory survives store instances, not reloads. */
  async reconcilePendingWrite(key: string, protocolID = this.config.protocolID): Promise<boolean> {
    const controller = await this.getIdentityKey()
    const scope = JSON.stringify([
      this.config.networkPreset,
      this.config.serviceName,
      protocolID,
      controller,
      key
    ])
    return await withKVWriteLock(scope, async () => {
      const pending = pendingWrites.get(scope)
      if (pending === undefined) return true
      if (pending.transaction !== undefined) {
        try {
          await this.topicBroadcaster.broadcast(pending.transaction)
        } catch {
          return false
        }
      }
      const confirmed = await confirmKVWrite(
        async signal => await this.getResult({ key, controller, protocolID }, {}, signal),
        pending.removing ? undefined : `${pending.txid}.0`
      )
      if (confirmed) pendingWrites.delete(scope)
      return confirmed
    })
  }

  override async set(key: string, value: string, options: KVStoreSetOptions = {}): Promise<string> {
    return await this.write(key, options.protocolID, async controller => {
      const outpoint = await super.set(key, value, options)
      const confirmed = await confirmKVWrite(
        async signal =>
          await this.getResult(
            {
              key,
              controller,
              protocolID: options.protocolID ?? this.config.protocolID
            },
            {},
            signal
          ),
        outpoint
      )
      if (!confirmed) throw new KVStoreWriteError('unconfirmed', outpoint.split('.')[0])
      return outpoint
    })
  }

  override async remove(
    key: string,
    outputs?: CreateActionOutput[],
    options: KVStoreRemoveOptions = {}
  ): Promise<string> {
    return await this.write(
      key,
      options.protocolID,
      async controller => {
        const txid = await super.remove(key, outputs, options)
        const confirmed = await confirmKVWrite(
          async () =>
            await this.getResult({
              key,
              controller,
              protocolID: options.protocolID ?? this.config.protocolID
            }),
          undefined
        )
        if (!confirmed) throw new KVStoreWriteError('unconfirmed', txid)
        return txid
      },
      true
    )
  }
}
