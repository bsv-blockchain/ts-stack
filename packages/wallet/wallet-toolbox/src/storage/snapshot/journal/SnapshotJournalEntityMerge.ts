import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../../StorageKnex'
import type { SyncChunk } from '../../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { TableProvenTx } from '../../schema/tables'
import { mergeSyncChunkEntities } from '../../schema/entities/mergeSyncChunkEntities'
import { validateSyncProof } from '../../methods/validateSyncProof'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import type { SnapshotJournalDelta } from './SnapshotJournalDeltaPage'
import { encodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import {
  readSnapshotJournalCapturedIdentities,
  type SnapshotJournalCapturedIdentity
} from './SnapshotJournalCapturedIdentities'
import {
  snapshotJournalDestinationStreams,
  withSnapshotJournalDestinationWindowFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import type { SnapshotJournalDestinationStageReceipt } from './SnapshotJournalDestinationStage'
import {
  applySnapshotJournalIdentityTransition,
  type SnapshotJournalIdentityTransitionLimits
} from './SnapshotJournalIdentityRetirements'
import {
  loadSnapshotJournalDestinationParents,
  snapshotJournalIdentityEntities,
  verifySnapshotJournalDestinationIdentity
} from './SnapshotJournalDestinationIdentities'
import {
  chargeSnapshotJournalAllocation,
  normalizeSnapshotJournalNativeRow,
  readSnapshotJournalNativeEntityRows,
  snapshotJournalNativeFindTable,
  verifySnapshotJournalEntityIndexes,
  type SnapshotJournalAllocationBudget,
  type SnapshotJournalEntityTable
} from './SnapshotJournalNativeRows'
import { brc38ImportTargetIndexName } from '../../portable/Brc38ImportTargetIndexes'
import {
  snapshotJournalLocalMembershipKey,
  updateSnapshotJournalMembership,
  readSnapshotJournalMembershipPreimage,
  readSnapshotJournalInheritedMembershipPreimage,
  type SnapshotJournalMembershipLimits
} from './SnapshotJournalMemberships'

export interface SnapshotJournalEntityMergeLimits
  extends SnapshotJournalIdentityTransitionLimits, SnapshotJournalMembershipLimits {}

const tables: readonly (SnapshotJournalEntityTable | 'syncStates')[] = [
  'transactions',
  'outputs',
  'certificates',
  'txLabels',
  'outputBaskets',
  'outputTags',
  'commissions',
  'syncStates',
  'provenTxs',
  'provenTxReqs',
  'txLabelMaps',
  'outputTagMaps',
  'certificateFields'
]
const writes = new Set([
  'insertProvenTx',
  'updateProvenTx',
  'insertProvenTxReq',
  'updateProvenTxReq',
  'insertTransaction',
  'updateTransaction',
  'insertOutput',
  'updateOutput',
  'insertCertificate',
  'updateCertificate',
  'insertCertificateField',
  'updateCertificateField',
  'insertOutputBasket',
  'updateOutputBasket',
  'insertOutputTag',
  'updateOutputTag',
  'insertTxLabel',
  'updateTxLabel',
  'insertTxLabelMap',
  'updateTxLabelMap',
  'insertOutputTagMap',
  'updateOutputTagMap',
  'insertCommission',
  'updateCommission'
])
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal semantic application differs from its prepared staged row')
}
function rowDigest(change: SnapshotJournalDelta, receipt: SnapshotJournalDestinationStageReceipt): string {
  const context = snapshotJournalDestinationStreams[receipt.streamIndex]
  if (context === undefined || context.tableId !== receipt.tableId) invalid()
  const { revision, id1, id2, exactText } = change.metadata
  return createHash('sha256')
    .update(
      encodeSnapshotJournalDeltaFrame(
        {
          table: tables[receipt.tableId],
          changes: [change],
          examined: 1,
          payloadBytes: 0,
          complete: false,
          after: { revision, id1, id2, exactText }
        },
        context
      )
    )
    .digest('hex')
}

async function* captured(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  digest: string,
  changeIndex: number
): AsyncGenerator<SnapshotJournalCapturedIdentity[]> {
  let after: { tableId: SnapshotJournalCapturedIdentity['tableId']; incomingId: number } | undefined
  while (true) {
    const batch = await readSnapshotJournalCapturedIdentities(k, binding, state, digest, changeIndex, after)
    if (batch.length === 0) return
    yield batch
    const last = batch[batch.length - 1]
    after = { tableId: last.tableId, incomingId: last.incomingId }
    if (batch.length < 128) return
  }
}

/** Keep the original proof epoch and artifact invalidation semantics. Bound
 * writer work using the owned ready index before invoking the native update;
 * never fetch BEEF bytes just to determine the invalidation set. */
async function invalidateProofArtifacts(
  k: Knex,
  storage: StorageKnex,
  budget: SnapshotJournalAllocationBudget
): Promise<number> {
  const remote = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  const query = k
    .from(
      k.raw(remote ? 'prepared_beefs FORCE INDEX (??)' : 'prepared_beefs INDEXED BY ??', [
        brc38ImportTargetIndexName('preparedBeefReady', k)
      ])
    )
    .where({ state: 'ready' })
    .select('preparedBeefId')
    .orderBy('preparedBeefId')
    .limit(4097)
  if (remote) query.forUpdate().noWait()
  const rows: Array<{ preparedBeefId: unknown }> = await query
  if (rows.length > 4096)
    throw new SnapshotResourceLimitError('Journal proof invalidation exceeds bounded writer capacity')
  chargeSnapshotJournalAllocation(budget, 256 * rows.length)
  if (rows.some(row => !Number.isSafeInteger(Number(row.preparedBeefId)) || Number(row.preparedBeefId) < 1)) invalid()
  return await storage.invalidatePreparedBeefs(k)
}

/** Internal, one-use prepared data. It confers no source, provider or destination
 * authority. The coordinator supplies the actual authenticated staged change
 * and a freshly verified source lease; the writer independently checks the
 * destination fence, original frame/row, live indexes and mapped natural keys. */
export class SnapshotJournalPreparedEntityMerge {
  #consumed = false
  private constructor(
    private readonly storage: StorageKnex,
    private readonly table: SnapshotJournalEntityTable,
    private readonly row: Record<string, unknown>,
    private readonly digest: string,
    private readonly frameDigest: string,
    private readonly changeIndex: number,
    private readonly budget: SnapshotJournalAllocationBudget,
    private readonly signal?: AbortSignal
  ) {}

  static async prepare(
    storage: StorageKnex,
    binding: SnapshotJournalDestinationBinding,
    change: SnapshotJournalDelta,
    receipt: SnapshotJournalDestinationStageReceipt,
    changeIndex: number,
    maximumAllocationBytes: number,
    signal?: AbortSignal
  ): Promise<SnapshotJournalPreparedEntityMerge> {
    signal?.throwIfAborted()
    const table = tables[receipt.tableId]
    if (
      !change.present ||
      table === undefined ||
      table === 'syncStates' ||
      !Number.isSafeInteger(changeIndex) ||
      changeIndex < 0 ||
      changeIndex > 255 ||
      !Number.isSafeInteger(maximumAllocationBytes) ||
      maximumAllocationBytes < 1 ||
      maximumAllocationBytes > 16777216
    )
      invalid()
    const digest = rowDigest(change, receipt)
    const budget = { remaining: maximumAllocationBytes }
    if (
      Object.hasOwn(change.row, 'userId') &&
      change.row.userId !== binding.source.userId &&
      Number(change.row.userId) !== binding.source.userId
    )
      invalid()
    const row = normalizeSnapshotJournalNativeRow(storage, table, change.row, budget)
    if (table === 'provenTxs') {
      // Keep this exact candidate object: the existing validator binds the
      // cryptographic replacement decision to it, not to a serialized token.
      await validateSyncProof(storage, row as unknown as TableProvenTx)
    }
    signal?.throwIfAborted()
    return new SnapshotJournalPreparedEntityMerge(
      storage,
      table,
      row,
      digest,
      receipt.digest,
      changeIndex,
      budget,
      signal
    )
  }

  async apply(
    k: Knex,
    binding: SnapshotJournalDestinationBinding,
    expected: SnapshotJournalDestinationCheckpoint,
    change: SnapshotJournalDelta,
    receipt: SnapshotJournalDestinationStageReceipt,
    changeIndex: number,
    limits: SnapshotJournalEntityMergeLimits
  ): Promise<{ inserts: number; updates: number }> {
    if (
      this.#consumed ||
      receipt.digest !== this.frameDigest ||
      changeIndex !== this.changeIndex ||
      rowDigest(change, receipt) !== this.digest
    )
      invalid()
    this.#consumed = true
    this.signal?.throwIfAborted()
    return await withSnapshotJournalDestinationWindowFence(k, binding, expected, async fenced => {
      await verifySnapshotJournalEntityIndexes(fenced)
      const { map, self } = await loadSnapshotJournalDestinationParents(
        fenced,
        binding,
        expected,
        captured(fenced, binding, expected, receipt.digest, changeIndex),
        limits,
        this.budget
      )
      let preimage: { fingerprint: string; generation: string; inheritedCreated?: true } | undefined =
        await readSnapshotJournalMembershipPreimage(fenced, binding, receipt.tableId, change, this.budget)
      const chunk = {
        fromStorageIdentityKey: binding.source.storageIdentity,
        toStorageIdentityKey: binding.destinationStorageIdentity,
        userIdentityKey: binding.source.identityKey,
        [this.table]: [this.row]
      } as SyncChunk
      const merge = async (trx: Knex): Promise<{ inserts: number; updates: number }> => {
        const storage = this.storage
        const adapter = new Proxy(storage, {
          get: (target, name) => {
            if (typeof name !== 'string') return Reflect.get(target, name)
            if (name.startsWith('find'))
              return async (args: { partial: Readonly<Record<string, string | number>>; trx?: unknown }) => {
                const rows = await readSnapshotJournalNativeEntityRows(trx, storage, name, args, this.budget)
                if (snapshotJournalNativeFindTable(name) === this.table && rows.length === 1) {
                  const inherited = await readSnapshotJournalInheritedMembershipPreimage(
                    trx,
                    binding,
                    receipt.tableId,
                    rows[0],
                    this.budget
                  )
                  if (inherited !== undefined) preimage = inherited
                }
                return rows
              }
            if (name === 'invalidatePreparedBeefs')
              return async (token: unknown) => {
                if (token !== trx) invalid()
                return await invalidateProofArtifacts(trx, storage, this.budget)
              }
            if (!writes.has(name)) invalid()
            const method: unknown = Reflect.get(target, name)
            if (typeof method !== 'function') invalid()
            return async (...args: unknown[]) => {
              this.signal?.throwIfAborted()
              if (args[args.length - 1] !== trx) invalid()
              return await Reflect.apply(method, target, args)
            }
          }
        })
        const result = await mergeSyncChunkEntities(adapter, binding.destinationUserId, undefined, chunk, map, trx, {
          preserveManagedChangePolicy: true
        })
        this.signal?.throwIfAborted()
        return { inserts: result.inserts, updates: result.updates }
      }
      if (self === undefined) {
        if (receipt.tableId < 10) invalid()
        const result = await merge(fenced)
        await updateSnapshotJournalMembership(
          fenced,
          binding,
          expected,
          receipt.tableId,
          change,
          snapshotJournalLocalMembershipKey(receipt.tableId, change, map),
          result.inserts === 1,
          limits,
          this.budget,
          preimage
        )
        return result
      }
      if (
        self.tableId !== receipt.tableId ||
        self.incomingId !== change.metadata.id1 ||
        (change.metadata.generation !== undefined && self.generation !== change.metadata.generation)
      )
        invalid()
      return await applySnapshotJournalIdentityTransition(
        fenced,
        binding,
        expected,
        [self],
        limits,
        async (trx, associations) => {
          const key = self.tableId + ':' + self.incomingId
          const previous = associations.get(key)
          if (previous !== undefined) {
            await verifySnapshotJournalDestinationIdentity(trx, binding.destinationUserId, self, previous, map)
            map[snapshotJournalIdentityEntities[self.tableId]].idMap[self.incomingId] = previous.localId
          }
          const result = await merge(trx)
          const localId = map[snapshotJournalIdentityEntities[self.tableId]].idMap[self.incomingId]
          if (!Number.isSafeInteger(localId) || localId < 1) invalid()
          await verifySnapshotJournalDestinationIdentity(
            trx,
            binding.destinationUserId,
            self,
            { generation: self.generation, naturalIdentity: self.naturalIdentity, localId },
            map
          )
          await updateSnapshotJournalMembership(
            trx,
            binding,
            expected,
            receipt.tableId,
            change,
            snapshotJournalLocalMembershipKey(receipt.tableId, change, map),
            result.inserts === 1,
            limits,
            this.budget,
            preimage
          )
          return { assignments: new Map([[key, localId]]), result }
        }
      )
    })
  }
}
