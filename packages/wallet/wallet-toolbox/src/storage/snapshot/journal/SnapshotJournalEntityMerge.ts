import { promiseFromSync } from '../../../utility/promiseFromSync'
import type { Brc38ImportTargetIndex } from '../../portable/Brc38ImportTargetIndexes'
import type { SyncMap } from '../../schema/entities/EntityBase'
import type { SnapshotJournalHashedFieldDelta } from './SnapshotJournalFieldTypes'
import type { SnapshotJournalPreparedPromotionEffect } from './KnexSnapshotJournalDestination'
import {
  assertRemoteSnapshotJournalFieldFrame,
  type RemoteSnapshotJournalFieldArchive,
  type RemoteSnapshotJournalFieldFrame
} from './openRemoteSnapshotJournalFieldArchive'
import { encodeSnapshotJournalFieldFrame } from './SnapshotJournalDeltaFrame'
import { snapshotJournalReceiptBinding } from './SnapshotJournalReceipt'
import { readSnapshotJournalDestinationFieldPromotionPage } from './SnapshotJournalDestinationStage'
import { requireSnapshotJournalCapturedFrame } from './SnapshotJournalCapturedIdentities'
import { snapshotJournalDeltaSources, fieldColumns } from './SnapshotJournalFieldSql'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { SnapshotJournalDestinationLimits, SnapshotJournalWriterAdmission } from './SnapshotJournalProvider'
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
  snapshotJournalIndexedEntityQuery,
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
  type SnapshotJournalMembershipChange,
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
function fieldRowDigest(
  change: SnapshotJournalHashedFieldDelta,
  receipt: SnapshotJournalDestinationStageReceipt
): string {
  const context = snapshotJournalDestinationStreams[receipt.streamIndex]
  if (!change.present || context?.tableId !== receipt.tableId) invalid()
  const { revision, id1, id2, exactText } = change.metadata,
    bytes = encodeSnapshotJournalFieldFrame(
      {
        table: tables[receipt.tableId],
        changes: [change],
        examined: 1,
        metadataBytes: 0,
        fieldBytes: Object.values(change.fields).reduce((total, field) => total + field.bytes, 0),
        complete: false,
        after: { revision, id1, id2, exactText }
      },
      context
    )
  try {
    return createHash('sha256').update(bytes).digest('hex')
  } finally {
    bytes.fill(0)
  }
}

export async function* readSnapshotJournalEntityFrameIdentities(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  digest: string,
  changeIndex: number,
  scope?: 'request-scalars'
): AsyncGenerator<SnapshotJournalCapturedIdentity[]> {
  let after: { tableId: SnapshotJournalCapturedIdentity['tableId']; incomingId: number } | undefined
  while (true) {
    const batch = await readSnapshotJournalCapturedIdentities(
      k,
      binding,
      state,
      digest,
      changeIndex,
      after,
      scope === undefined ? undefined : { kind: scope }
    )
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

class OrdinaryFieldReuseMiss extends Error {}

type OrdinaryFieldLookup = Readonly<{
  index: Brc38ImportTargetIndex
  partial: Readonly<Record<string, string | number>>
}>

/** Indexed byte reuse only. A matching hash never substitutes for current
 * identity/parent/proof/financial checks in the original merge below. */
function ordinaryFieldLookups(
  tableId: number,
  change: Extract<SnapshotJournalHashedFieldDelta, { present: true }>,
  userId: number,
  map?: SyncMap
): readonly OrdinaryFieldLookup[] {
  const row = change.row,
    text = (name: string, maximum = 400): string | undefined => {
      const value = row[name]
      return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum ? value : undefined
    },
    parent = (entity: 'transaction' | 'certificate', name: string): number | undefined => {
      const incoming = row[name]
      if (!Number.isSafeInteger(incoming) || Number(incoming) < 1) return undefined
      const local = map?.[entity].idMap[Number(incoming)]
      return typeof local === 'number' && Number.isSafeInteger(local) && local > 0 ? local : undefined
    },
    result: OrdinaryFieldLookup[] = []
  const add = (index: Brc38ImportTargetIndex, partial: Record<string, string | number | undefined>) => {
    if (Object.values(partial).every(value => value !== undefined))
      result.push({ index, partial: partial as Record<string, string | number> })
  }
  if (tableId === 0) {
    if (text('txid', 64)) add('transactions', { userId, txid: text('txid', 64) })
    if (text('reference', 128)) add('transactionReference', { userId, reference: text('reference', 128) })
  } else if (tableId === 1 && Number.isSafeInteger(row.vout) && Number(row.vout) >= 0)
    add('outputs', { userId, transactionId: parent('transaction', 'transactionId'), vout: Number(row.vout) })
  else if (tableId === 2)
    add('certificates', { userId, certifier: text('certifier', 130), serialNumber: text('serialNumber') })
  else if (tableId === 3) add('txLabels', { userId, label: text('label') })
  else if (tableId === 4) add('outputBaskets', { userId, name: text('name') })
  else if (tableId === 5) add('outputTags', { userId, tag: text('tag') })
  else if (tableId === 6) add('commissions', { userId, transactionId: parent('transaction', 'transactionId') })
  else if (tableId === 8 || tableId === 9) add(tableId === 8 ? 'provenTxs' : 'provenTxReqs', { txid: text('txid', 64) })
  else if (tableId === 12)
    add('certificateFields', {
      userId,
      certificateId: parent('certificate', 'certificateId'),
      fieldName: change.metadata.exactText
    })
  return result
}

/** An actual target's already persisted cells serve as a discardable byte
 * cache. Every <=16KiB extent is read under a fresh real target/window grant;
 * only a full independent hash match may avoid the source payload download.
 * No extra blob copy, persisted hash verdict, schema cache or SQL actor exists. */
async function prepareOrdinaryFieldReuse(
  storage: StorageKnex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  receipt: SnapshotJournalDestinationStageReceipt,
  changeIndex: number,
  frame: RemoteSnapshotJournalFieldFrame,
  limits: SnapshotJournalDestinationLimits,
  admission: SnapshotJournalWriterAdmission,
  check: () => void,
  signal?: AbortSignal
): Promise<
  ((field: string, bytes: number, offset: number, length: number) => Promise<Uint8Array | undefined>) | undefined
> {
  const root = storage.knex,
    change = frame.page.changes[changeIndex]
  if (!change?.present || typeof admission !== 'function') invalid()
  const writer = async <T>(apply: (trx: Knex) => Promise<T>): Promise<T> => {
    check()
    return await admission(
      async () =>
        await storage.runSnapshotJournalWriter(
          async (trx, backend) => {
            check()
            if (storage.knex !== root || backend !== binding.destinationBackend) invalid()
            const owner = require('./SnapshotJournalOwnedWriter') as typeof import('./SnapshotJournalOwnedWriter')
            owner.requireSnapshotJournalOwnedWriter(trx, root, backend)
            await (
              require('./SnapshotJournalDestinationSchema') as typeof import('./SnapshotJournalDestinationSchema')
            ).verifySnapshotJournalDestinationSchema(trx)
            await (
              require('./SnapshotJournalLifecycle') as typeof import('./SnapshotJournalLifecycle')
            ).readSnapshotJournalCaptureConfiguration(trx)
            return await withSnapshotJournalDestinationWindowFence(trx, binding, state, async fenced => {
              await requireSnapshotJournalCapturedFrame(
                fenced,
                binding,
                state,
                receipt.digest,
                frame.page.changes.length
              )
              await verifySnapshotJournalEntityIndexes(fenced)
              const result = await apply(fenced)
              check()
              return result
            })
          },
          binding.destinationBackend,
          signal
        )
    )
  }
  let selected: OrdinaryFieldLookup | undefined
  try {
    selected = await writer(async trx => {
      // This optional lookup uses the already charged fixed metadata allowance.
      // Exhausting it is a cache miss, never a change to financial admission.
      let map: SyncMap | undefined
      if ([1, 6, 12].includes(receipt.tableId)) {
        const references = readSnapshotJournalEntityFrameIdentities(trx, binding, state, receipt.digest, changeIndex)
        async function* boundedReferences() {
          let count = 0
          for await (const batch of references) {
            count += batch.length
            if (count > 16) throw new OrdinaryFieldReuseMiss()
            yield batch
          }
        }
        map = (
          await loadSnapshotJournalDestinationParents(trx, binding, state, boundedReferences(), limits, {
            remaining: 65536
          })
        ).map
      }
      for (const lookup of ordinaryFieldLookups(receipt.tableId, change, binding.destinationUserId, map)) {
        const rows = await snapshotJournalIndexedEntityQuery(trx, lookup.index, lookup.partial).select(
          trx.raw('1 AS present')
        )
        if (rows.length > 1) invalid()
        if (rows.length === 1)
          return Object.freeze({ index: lookup.index, partial: Object.freeze({ ...lookup.partial }) })
      }
      return undefined
    })
  } catch (error) {
    if (error instanceof SnapshotResourceLimitError || error instanceof OrdinaryFieldReuseMiss) return undefined
    throw error
  }
  if (selected === undefined) return undefined
  const lookup = selected
  return async (field, bytes, offset, length) => {
    if (
      !Object.hasOwn(change.fields, field) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 16384 ||
      offset + length > bytes ||
      change.fields[field].bytes !== bytes
    )
      invalid()
    return await writer(async trx => {
      const mysql = ['mysql', 'mysql2'].includes(String(trx.client.config.client)),
        descriptor = change.fields[field],
        valid = mysql ? '1' : `typeof(??)='${descriptor.kind === 'binary' ? 'blob' : 'text'}'`,
        size = mysql ? 'octet_length(??)' : 'length(CAST(?? AS BLOB))',
        slice = mysql ? 'substr(CAST(?? AS BINARY),?,?)' : 'substr(CAST(?? AS BLOB),?,?)',
        rows: Array<{ payload: unknown }> = await snapshotJournalIndexedEntityQuery(
          trx,
          lookup.index,
          lookup.partial
        ).select(
          trx.raw(`CASE WHEN ${valid} AND ${size}=? THEN ${slice} ELSE NULL END AS payload`, [
            ...(mysql ? [] : [field]),
            field,
            bytes,
            field,
            offset + 1,
            length
          ])
        )
      if (rows.length > 1) invalid()
      if (rows.length === 0 || rows[0].payload === null) return undefined
      if (!(rows[0].payload instanceof Uint8Array) || rows[0].payload.length !== length) invalid()
      return rows[0].payload
    })
  }
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
    private readonly signal?: AbortSignal,
    private readonly changeDigest: typeof rowDigest = rowDigest
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

  /** Actual field archive -> complete bounded ordinary SQL row. Every payload
   * is present and independently hashed before the original financial kernel
   * runs. This never creates a native source or uses absent financial cells. */
  static async prepareArchiveFields(
    storage: StorageKnex,
    inputBinding: SnapshotJournalDestinationBinding,
    inputState: SnapshotJournalDestinationCheckpoint,
    inputReceipt: SnapshotJournalDestinationStageReceipt,
    changeIndex: number,
    archive: RemoteSnapshotJournalFieldArchive,
    frame: RemoteSnapshotJournalFieldFrame,
    inputLimits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal
  ): Promise<SnapshotJournalPreparedPromotionEffect<SnapshotJournalHashedFieldDelta>> {
    const limits = Object.freeze({ ...inputLimits }),
      maximumAllocationBytes = limits.maximumAllocationBytes,
      binding = structuredClone(inputBinding),
      state = structuredClone(inputState),
      receipt = { ...inputReceipt },
      root = storage.knex,
      originalBinding = JSON.stringify(binding),
      originalState = JSON.stringify(state),
      page = frame.page,
      change = page.changes[changeIndex],
      table = tables[receipt.tableId],
      context = snapshotJournalDestinationStreams[receipt.streamIndex],
      expiresAt = Math.min(archive.expiresAt, binding.receipt.expiresAt),
      deadline = performance.now() + expiresAt - Date.now(),
      buffers = new Set<Uint8Array>(),
      budget = { remaining: maximumAllocationBytes }
    let closed = false,
      consumed = false,
      normalized: Record<string, unknown> | undefined,
      completeRow: Record<string, unknown> | undefined
    const check = () => {
      signal?.throwIfAborted()
      assertRemoteSnapshotJournalFieldFrame(archive, frame)
      if (
        closed ||
        storage.knex !== root ||
        root.isTransaction ||
        isOwnedNativeSqlite(root) ||
        !['sqlite3', 'better-sqlite3', 'mysql', 'mysql2'].includes(String(root.client.config.client)) ||
        Date.now() >= expiresAt ||
        performance.now() >= deadline
      )
        invalid()
    }
    const close = () => {
      return promiseFromSync(() => {
        closed = true
        for (const bytes of buffers) bytes.fill(0)
        buffers.clear()
        for (const row of [normalized, completeRow])
          if (row !== undefined)
            for (const [name, value] of Object.entries(row)) {
              if (value instanceof Uint8Array || Array.isArray(value)) value.fill(0)
              delete row[name]
            }
      })
    }
    try {
      check()
      if (
        !Number.isSafeInteger(maximumAllocationBytes) ||
        maximumAllocationBytes < 1 ||
        maximumAllocationBytes > 16777216 ||
        !Number.isSafeInteger(changeIndex) ||
        changeIndex < 0 ||
        changeIndex > 255 ||
        change?.present !== true ||
        table === undefined ||
        table === 'syncStates' ||
        context?.tableId !== frame.tableId ||
        context.stream !== frame.stream ||
        receipt.tableId !== frame.tableId ||
        frame.ordinal !== receipt.sequence - 1 ||
        state.phase !== 'promoting' ||
        binding.fieldEncoding !== 'wallet-journal-fields/1' ||
        archive.manifest.binding.user.identityKey !== binding.source.identityKey ||
        snapshotJournalReceiptBinding(archive.manifest.binding.journal.source) !==
          snapshotJournalReceiptBinding(binding.source) ||
        JSON.stringify(archive.manifest.binding.journal.receipt) !== JSON.stringify(binding.receipt) ||
        archive.manifest.binding.journal.low !== binding.low ||
        archive.manifest.binding.journal.bootstrap !== (binding.bootstrap === true)
      )
        invalid()
      const encoded = encodeSnapshotJournalFieldFrame(page, context)
      try {
        if (
          encoded.length !== receipt.bytes ||
          createHash('sha256').update(encoded).digest('hex') !== receipt.digest ||
          receipt.digest !== frame.frameDigest
        )
          invalid()
        chargeSnapshotJournalAllocation(budget, 16 * encoded.length + 65536)
      } finally {
        encoded.fill(0)
      }
      const names = Object.keys(change.fields),
        allowed = fieldColumns(snapshotJournalDeltaSources[receipt.tableId], names)
      if (names.length < 1 || allowed.deferred.length !== names.length) invalid()
      if (Object.hasOwn(change.row, 'userId') && Number(change.row.userId) !== binding.source.userId) invalid()
      // Precharge the entire simultaneous input before the first field read.
      // Normalization and target reads consume this same remaining allowance.
      for (const name of names) {
        const descriptor = change.fields[name]
        if (descriptor.kind !== (allowed.binary(name) ? 'binary' : 'utf8')) invalid()
        chargeSnapshotJournalAllocation(budget, 16 * descriptor.bytes + 512)
      }
      const reuse = await prepareOrdinaryFieldReuse(
        storage,
        binding,
        state,
        receipt,
        changeIndex,
        frame,
        limits,
        admission,
        check,
        signal
      )
      completeRow = { ...change.row }
      for (const name of names) {
        const descriptor = change.fields[name],
          bytes = new Uint8Array(descriptor.bytes)
        buffers.add(bytes)
        let reused = reuse !== undefined,
          offset = 0,
          hash = createHash('sha256')
        if (reuse !== undefined) {
          while (offset < bytes.length) {
            check()
            const length = Math.min(16384, bytes.length - offset),
              part = await reuse(name, bytes.length, offset, length)
            if (part === undefined) {
              reused = false
              break
            }
            try {
              bytes.set(part, offset)
              hash.update(part)
              offset += part.length
            } finally {
              part.fill(0)
            }
          }
          // A current target is optional cached DATA. Mutation, disappearance
          // or a different digest selects a real source read, never a verdict.
          reused = reused && offset === bytes.length && hash.digest('hex') === descriptor.sha256
        }
        hash = createHash('sha256')
        if (!reused) {
          bytes.fill(0)
          offset = 0
          while (offset < bytes.length) {
            check()
            const length = Math.min(16384, bytes.length - offset),
              part = await archive.readFieldExtent(frame, changeIndex, name, offset, length)
            try {
              if (part.length !== length) invalid()
              bytes.set(part, offset)
              hash.update(part)
              offset += part.length
            } finally {
              part.fill(0)
            }
          }
          if (hash.digest('hex') !== descriptor.sha256) invalid()
        }
        const eof = await archive.readFieldExtent(frame, changeIndex, name, bytes.length, 0)
        try {
          if (eof.length !== 0) invalid()
        } finally {
          eof.fill(0)
        }
        if (descriptor.kind === 'binary') completeRow[name] = bytes
        else {
          completeRow[name] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
          bytes.fill(0)
          buffers.delete(bytes)
        }
      }
      const digestChange = (
          value: SnapshotJournalDelta,
          actualReceipt: SnapshotJournalDestinationStageReceipt
        ): string => {
          if (!value.present) invalid()
          const small = { ...value.row }
          for (const name of names) {
            const descriptor = change.fields[name],
              cell = small[name]
            if (descriptor.kind === 'binary' ? !(cell instanceof Uint8Array) : typeof cell !== 'string') invalid()
            const bytes = typeof cell === 'string' ? Buffer.from(cell, 'utf8') : (cell as Uint8Array)
            try {
              if (
                bytes.length !== descriptor.bytes ||
                createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256
              )
                invalid()
            } finally {
              if (typeof cell === 'string') bytes.fill(0)
            }
            delete small[name]
          }
          return fieldRowDigest(
            { metadata: value.metadata, present: true, row: small, fields: change.fields },
            actualReceipt
          )
        },
        complete: SnapshotJournalDelta = { metadata: change.metadata, present: true, row: completeRow },
        digest = digestChange(complete, receipt)
      normalized = normalizeSnapshotJournalNativeRow(storage, table, completeRow, budget)
      if (table === 'provenTxs') await validateSyncProof(storage, normalized as unknown as TableProvenTx)
      check()
      const effect = new SnapshotJournalPreparedEntityMerge(
        storage,
        table,
        normalized,
        digest,
        receipt.digest,
        changeIndex,
        budget,
        signal,
        digestChange
      )
      const prepared: SnapshotJournalPreparedPromotionEffect<SnapshotJournalHashedFieldDelta> = {
        apply: async (trx, actualBinding, actualState, actualChange, actualReceipt, actualIndex) => {
          check()
          if (
            consumed ||
            JSON.stringify(actualBinding) !== originalBinding ||
            JSON.stringify(actualState) !== originalState ||
            actualIndex !== changeIndex ||
            JSON.stringify(actualReceipt) !== JSON.stringify(receipt) ||
            fieldRowDigest(actualChange, actualReceipt) !== digest
          )
            invalid()
          const owner = require('./SnapshotJournalOwnedWriter') as typeof import('./SnapshotJournalOwnedWriter')
          owner.requireSnapshotJournalOwnedWriter(trx, root, binding.destinationBackend)
          const staged = await readSnapshotJournalDestinationFieldPromotionPage(trx, binding, state)
          if (
            staged === undefined ||
            staged.receipt.digest !== receipt.digest ||
            staged.receipt.sequence !== receipt.sequence ||
            staged.page.changes[changeIndex] === undefined ||
            fieldRowDigest(staged.page.changes[changeIndex], staged.receipt) !== digest
          )
            invalid()
          await requireSnapshotJournalCapturedFrame(trx, binding, state, receipt.digest, staged.page.changes.length)
          consumed = true
          const result = await effect.apply(
            trx,
            actualBinding,
            actualState,
            complete,
            actualReceipt,
            actualIndex,
            limits
          )
          check()
          return result
        },
        close
      }
      return Object.freeze(prepared)
    } catch (cause) {
      await close()
      throw cause
    }
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
      this.changeDigest(change, receipt) !== this.digest
    )
      invalid()
    this.#consumed = true
    this.signal?.throwIfAborted()
    return await applySnapshotJournalPreparedEntityEffect(
      k,
      binding,
      expected,
      change,
      receipt,
      changeIndex,
      limits,
      this.budget,
      async (trx, map, observeCurrent) => {
        const chunk = {
          fromStorageIdentityKey: binding.source.storageIdentity,
          toStorageIdentityKey: binding.destinationStorageIdentity,
          userIdentityKey: binding.source.identityKey,
          [this.table]: [this.row]
        } as SyncChunk
        const storage = this.storage
        const adapter = new Proxy(storage, {
          get: (target, name) => {
            if (typeof name !== 'string') return Reflect.get(target, name)
            if (name.startsWith('find'))
              return async (args: { partial: Readonly<Record<string, string | number>>; trx?: unknown }) => {
                const rows = await readSnapshotJournalNativeEntityRows(trx, storage, name, args, this.budget)
                if (snapshotJournalNativeFindTable(name) === this.table && rows.length === 1) {
                  await observeCurrent(rows[0])
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
    )
  }
}

/** Shared actual identity/parent/membership effect boundary. An incoming row or
 * field descriptor cannot supply SQL authority. The caller owns a real admitted
 * destination writer plus a one-use prepared semantic effect; this function
 * freshly loads captured identities, checks natural keys/generations and records
 * actual postimage custody in the same savepoint. No source/network I/O here. */
export async function applySnapshotJournalPreparedEntityEffect(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  change: SnapshotJournalMembershipChange,
  receipt: SnapshotJournalDestinationStageReceipt,
  changeIndex: number,
  limits: SnapshotJournalEntityMergeLimits,
  budget: SnapshotJournalAllocationBudget,
  effect: (
    trx: Knex,
    map: SyncMap,
    observeCurrent: (row: Readonly<Record<string, unknown>>) => Promise<void>
  ) => Promise<{ inserts: number; updates: number }>,
  parentScope?: 'request-scalars'
): Promise<{ inserts: number; updates: number }> {
  if (
    (parentScope !== undefined && (parentScope !== 'request-scalars' || receipt.tableId !== 9)) ||
    !change.present ||
    !change.metadata.present ||
    !Number.isSafeInteger(changeIndex) ||
    changeIndex < 0 ||
    changeIndex > 255 ||
    snapshotJournalDestinationStreams[receipt.streamIndex]?.tableId !== receipt.tableId
  )
    invalid()
  return await withSnapshotJournalDestinationWindowFence(k, binding, expected, async fenced => {
    await verifySnapshotJournalEntityIndexes(fenced)
    const { map, self } = await loadSnapshotJournalDestinationParents(
      fenced,
      binding,
      expected,
      readSnapshotJournalEntityFrameIdentities(fenced, binding, expected, receipt.digest, changeIndex, parentScope),
      limits,
      budget
    )
    let preimage: { fingerprint: string; generation: string; inheritedCreated?: true } | undefined =
      await readSnapshotJournalMembershipPreimage(fenced, binding, receipt.tableId, change, budget)
    const merge = async (trx: Knex): Promise<{ inserts: number; updates: number }> =>
      await effect(trx, map, async row => {
        const inherited = await readSnapshotJournalInheritedMembershipPreimage(
          trx,
          binding,
          receipt.tableId,
          row,
          budget
        )
        if (inherited !== undefined) preimage = inherited
      })
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
        budget,
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
    let missingBootstrapLocalId: number | undefined
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
          budget,
          preimage,
          missingBootstrapLocalId
        )
        return { assignments: new Map([[key, localId]]), result }
      },
      binding.bootstrap === true
        ? async (trx, _reference, association) => {
            const present = await verifySnapshotJournalDestinationIdentity(
              trx,
              binding.destinationUserId,
              self,
              association,
              map,
              true
            )
            if (!present) missingBootstrapLocalId = association.localId
            return present
          }
        : undefined
    )
  })
}
