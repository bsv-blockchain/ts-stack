import { awaitFromSync, mapAwaitFromSync } from '../utility/promiseFromSync'
import type { StorageProvider } from './StorageProvider'
import type { StorageActiveWrite, StorageWriterAdmission } from './StorageActiveWrite'
import type { TrxToken } from '../sdk/WalletStorage.interfaces'
import type { TransactionStatus } from '../sdk/types'
import { EntityProvenTxReq } from './schema/entities/EntityProvenTxReq'
import { WalletError } from '../sdk/WalletError'
import { WERR_INVALID_OPERATION, WERR_NOT_ACTIVE, WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { verifyOne } from '../utility/utilityHelpers'

/** @internal Captures real participating profiles before asynchronous work.
 * A request is shared cache data; its notification IDs never authorize another
 * user's financial writes. No SQL connection survives any callback here.
 */
export class StorageReqWrite {
  private readonly profiles = new Map<number, StorageActiveWrite | undefined>()
  private readonly transactions = new Map<string, Map<number, number[]>>()

  private constructor(
    private readonly storage: StorageProvider,
    private readonly actor?: { userId: number; write: StorageActiveWrite },
    private readonly admission?: StorageWriterAdmission
  ) {}

  static async capture(
    storage: StorageProvider,
    txids: string[],
    actor?: { userId: number; write: StorageActiveWrite },
    admission?: StorageWriterAdmission
  ): Promise<StorageReqWrite> {
    const captured = new StorageReqWrite(storage, actor, admission)
    for (const txid of new Set(txids)) {
      const users = new Map<number, number[]>()
      const rows = await storage.findTransactions({ partial: { txid }, noRawTx: true })
      for (const row of rows) {
        const ids = users.get(row.userId) ?? []
        ids.push(row.transactionId)
        users.set(row.userId, ids)
        if (captured.profiles.has(row.userId)) continue
        if (row.userId === actor?.userId) {
          captured.profiles.set(row.userId, actor.write)
          continue
        }
        const user = verifyOne(await storage.findUsers({ partial: { userId: row.userId } }))
        try {
          captured.profiles.set(row.userId, await storage.activeWriteTransaction(user))
        } catch (error) {
          if (!isObsolete(error)) throw error
          // Keep the absent capture: an inactive profile cannot become eligible
          // by being freshly captured after an observation or network reply.
          captured.profiles.set(row.userId, undefined)
        }
      }
      captured.transactions.set(txid, users)
    }
    return captured
  }

  /** A predeclared signed transaction may be inserted by this same actual
   * actor after preparation. Refresh only that actor's committed row IDs under
   * its original epoch; never capture a newly appearing peer or a new role. */
  async refreshCommittedActorTransactions(txid: string): Promise<void> {
    const actor = this.actor
    const users = this.transactions.get(txid)
    if (actor == null || users == null || this.profiles.get(actor.userId) !== actor.write)
      throw new WERR_INVALID_OPERATION('Transaction was not declared by this captured actor')
    const ids = await this.admit(
      async () =>
        await actor.write.transaction(trx =>
          mapAwaitFromSync(
            () =>
              this.storage.findTransactions({
                partial: { txid, userId: actor.userId },
                noRawTx: true,
                trx
              }),
            rows => {
              if (rows.length === 0)
                throw new WERR_UNAUTHORIZED('No committed transaction belongs to the original actor')
              return rows.map(row => row.transactionId)
            }
          )
        )
    )
    users.set(actor.userId, ids)
  }

  assertRequests(reqs: EntityProvenTxReq[]): void {
    if (this.actor == null) return
    for (const req of reqs) {
      if (!this.transactions.get(req.txid)?.has(this.actor.userId))
        throw new WERR_UNAUTHORIZED('The proof request does not belong to the authenticated wallet')
    }
  }

  /** Older providers keep their serialized manager contract. Only actual
   * operation captures advertising commit-time epoch checks can prepare outside
   * that queue. This choice never supplies SQL or financial permission. */
  get preparesOutsideManager(): boolean {
    const writes = [...this.profiles.values()].filter((write): write is StorageActiveWrite => write != null)
    return (
      writes.length > 0 &&
      writes.every(write => write.prepareOutsideManager === true) &&
      (this.actor == null || this.actor.write.prepareOutsideManager === true)
    )
  }

  get hasParticipatingProfiles(): boolean {
    return this.profiles.size > 0
  }

  get requiresSerializedPreparation(): boolean {
    return (
      this.profiles.size === 0 ||
      [...this.profiles.values()].some(write => write != null && write.prepareOutsideManager !== true) ||
      (this.actor != null && this.actor.write.prepareOutsideManager !== true)
    )
  }

  async prepare<T>(operation: (storage: StorageProvider) => Promise<T>): Promise<T> {
    if (!this.preparesOutsideManager) throw new WERR_INVALID_OPERATION('Provider requires serialized preparation')
    await this.assertCurrent()
    return await operation(this.storage)
  }

  async assertCurrent(): Promise<void> {
    if (this.actor != null) return await this.actor.write.assertCurrent()
    if (this.profiles.size === 0) return // Cache-only orphan; no financial owner.
    for (const write of this.profiles.values()) {
      if (write == null) continue
      try {
        await write.assertCurrent()
        return
      } catch (error) {
        if (!isObsolete(error)) throw error
      }
    }
    throw new WERR_NOT_ACTIVE('No captured participating wallet profile is still active')
  }

  private async admit<T>(operation: () => Promise<T>): Promise<T> {
    return this.preparesOutsideManager && this.admission != null ? await this.admission(operation) : await operation()
  }

  async forUser(userId: number, apply: (trx: TrxToken) => Promise<void>): Promise<boolean> {
    const write = this.profiles.get(userId)
    if (write == null) return false
    try {
      await this.admit(() => awaitFromSync(() => write.transaction(apply)))
      return true
    } catch (error) {
      if (!isObsolete(error)) throw error
      return false
    }
  }

  assertProvider(storage: StorageProvider): void {
    if (storage !== this.storage) throw new WERR_INVALID_OPERATION('Request preparation belongs to another provider')
  }

  async forEachUser<T>(apply: (userId: number, trx: TrxToken) => Promise<T>): Promise<T[]> {
    const results: T[] = []
    for (const userId of this.profiles.keys()) {
      let result!: T
      if (
        await this.forUser(userId, async trx => {
          result = await apply(userId, trx)
        })
      )
        results.push(result)
    }
    return results
  }

  /** Refresh under the actual writable row lock. Late history/notification
   * additions survive; callbacks must mutate this fresh entity, not a snapshot.
   * An authenticated operation can never borrow another profile's authority.
   */
  async request(
    req: EntityProvenTxReq,
    apply: (current: EntityProvenTxReq, trx: TrxToken) => Promise<void | false>
  ): Promise<boolean> {
    this.assertRequests([req])
    let committed: EntityProvenTxReq | undefined
    const run = async (trx: TrxToken) => {
      const current = await EntityProvenTxReq.fromStorageId(this.storage, req.id, trx)
      if (current.txid !== req.txid) throw new WERR_NOT_ACTIVE('The selected proof request changed')
      if ((await apply(current, trx)) !== false) await current.updateStorageDynamicProperties(this.storage, trx)
      committed = current
    }
    const publish = () => {
      if (committed == null) throw new WERR_INVALID_OPERATION('Request writer did not complete')
      req.api = committed.api
      req.unpackApi()
    }
    if (this.actor != null) {
      await this.admit(() => awaitFromSync(() => this.actor!.write.transaction(run)))
      publish()
      return true
    }
    if (this.profiles.size === 0) {
      await this.storage.transaction(run)
      publish()
      return true
    }
    for (const userId of this.profiles.keys())
      if (await this.forUser(userId, run)) {
        publish()
        return true
      }
    return false
  }

  async status<T = never>(
    req: EntityProvenTxReq,
    status: TransactionStatus,
    after?: (userId: number, trx: TrxToken) => Promise<T>
  ): Promise<T[]> {
    const results: T[] = []
    for (const [userId, ids] of this.transactions.get(req.txid) ?? []) {
      let result: T | undefined
      const applied = await this.forUser(userId, async trx => {
        const current = await EntityProvenTxReq.fromStorageId(this.storage, req.id, trx)
        if (current.status === 'completed') return
        const nextStatus = current.status === 'unmined' ? 'unproven' : status
        let eligible = false
        for (const transactionId of ids) {
          const rows = await this.storage.findTransactions({
            partial: { transactionId, userId, txid: req.txid },
            noRawTx: true,
            trx
          })
          if (
            rows.length !== 1 ||
            rows[0].status === 'completed' ||
            rows[0].provenTxId != null ||
            (rows[0].status === 'failed' && nextStatus !== 'failed')
          )
            continue
          eligible = true
          if (rows[0].status !== nextStatus || nextStatus === 'failed')
            await this.storage.updateTransactionStatus(nextStatus, transactionId, undefined, undefined, trx)
        }
        // Failure cleanup and quarantine share this same actual profile writer.
        // Never quarantine after a competing proof/accepted-state advance.
        if (eligible && nextStatus === status && after != null) result = await after(userId, trx)
      })
      if (applied && result !== undefined) results.push(result)
    }
    return results
  }
}

function isObsolete(error: unknown): boolean {
  return WalletError.fromUnknown(error).code === 'WERR_NOT_ACTIVE'
}
