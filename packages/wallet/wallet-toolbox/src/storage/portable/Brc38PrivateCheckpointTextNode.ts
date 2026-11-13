import { promiseFromSync } from '../../utility/promiseFromSync'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { hasBrc38NativePackedTextSchema, nativePackedTextTables as names } from './Brc38NativePackedTextSchemaNode'
import {
  readBrc38NativePackedTextDescriptor,
  hashBrc38NativePackedTextVersion
} from './Brc38NativePackedTextFieldsNode'
import { brc38NativeTextCoordinate } from './Brc38NativeBlobProtocol'
import {
  withBrc38PrivateCurrentCheckpointActor,
  type Brc38PrivateCurrentStructuredPolicy
} from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38CheckpointSyncMapDelta, Brc38CheckpointSyncMapDeltas } from './Brc38CheckpointSyncMap'
import { brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { chargeBrc38ImportDecodedBudget, type Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'

interface Descriptor {
  readonly bytes: number
  readonly sha256: string
}
interface Version {
  bytes: number
  accepted: number
  chunks: number
  state: 'PENDING' | 'SEALED' | 'RETIRING'
}
export interface Brc38PrivateCheckpointText {
  readonly prior: Readonly<Descriptor>
  readonly output: Readonly<Descriptor>
  readonly maximumUpdatedAt?: string
  /** Before any row effects on this same final journal transaction. */
  assert(trx: Knex.Transaction): Promise<void>
  /** After the checkpoint metadata write; no payload or network I/O. */
  attach(trx: Knex.Transaction): Promise<void>
}
function invalid(): never {
  throw new Error('Private checkpoint text differs from its actual current map, owner or prepared content')
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Actual private current-map preparation. Two complete independent source/
 * grammar passes measure then replay the finite delta. Every source range
 * drains its query-only transaction before a short <=64KiB packed staging
 * writer. Current pointer, seal, schema and original admission are checked
 * again at every operation. No whole map/string/ID array is retained.
 *
 * Interrupted PENDING content remains charged in the candidate and its prefix
 * is compared with newly produced bytes. Complete stored postimages are hashed
 * on an actual read lease before the short SEALED transition. This is derived
 * content only: the enclosing journal owns row/maps/originals/checkpoint/receipt
 * and primary admission. No published source or activation authority is issued. */
export async function withBrc38PreparedPrivateCheckpointText<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  syncStateId: number,
  selected: Brc38PrivateCurrentStructuredPolicy,
  selectedDelta: Brc38CheckpointSyncMapDeltas,
  budget: Brc38ImportDecodedBudget,
  work: (prepared: Readonly<Brc38PrivateCheckpointText>) => Promise<T>,
  selectedLifetimes?: Brc38PrivateDerivedTextLifetimes
): Promise<T> {
  if (selectedLifetimes === undefined) {
    const working = brc38WorkingAllocation(selected.workingAllocation)
    if (working === undefined) invalid()
    return await Brc38PrivateDerivedTextLifetimes.with(
      store,
      { expiresAt: selected.expiresAt, workingAllocation: working, signal: selected.signal },
      async lifetimes =>
        await withBrc38PreparedPrivateCheckpointText(
          store,
          storage,
          syncStateId,
          selected,
          selectedDelta,
          budget,
          work,
          lifetimes
        )
    )
  }
  const deltas: readonly Brc38CheckpointSyncMapDelta[] = Array.isArray(selectedDelta)
    ? selectedDelta
    : [selectedDelta as Brc38CheckpointSyncMapDelta]
  if (deltas.length < 1 || deltas.length > 128) invalid()
  let mappingCount = 0
  for (const delta of deltas) {
    if (!Array.isArray(delta.mappings) || delta.mappings.length > 4000) invalid()
    mappingCount += delta.mappings.length
    if (mappingCount > 4000) invalid()
  }
  const root = storage.toDb(),
    origin = privateNativeDatabaseIdentity(root),
    policy = Object.freeze({
      ...brc38PrivateStructuredPolicy(selected, store.directory),
      expiresAt: selected.expiresAt,
      maximumCombinedTemporaryBytes: selected.maximumCombinedTemporaryBytes
    }),
    working = brc38WorkingAllocation(policy.workingAllocation),
    coordinate = Object.freeze({ table: 'syncStates' as const, field: 'syncMap' as const, rowId: syncStateId }),
    deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now()),
    effects = new Brc38OwnedImportReads(),
    captureBytes = 8192 + 1024 * mappingCount + 1024 * (deltas.length - 1)
  if (
    root !== store.knex ||
    origin?.slot !== 0 ||
    !Number.isSafeInteger(syncStateId) ||
    working === undefined ||
    policy.expiresAt !== store.limits.expiresAt ||
    !Number.isSafeInteger(budget.maximum) ||
    budget.maximum < 1 ||
    budget.maximum > store.limits.maximumRowAllocationBytes ||
    !Number.isSafeInteger(budget.remaining) ||
    budget.remaining < 0 ||
    budget.remaining > budget.maximum ||
    policy.maximumCombinedTemporaryBytes > store.limits.maximumPhysicalBytes ||
    policy.signal !== budget.signal ||
    working.maximum > store.limits.maximumRowAllocationBytes
  )
    invalid()
  chargeBrc38ImportDecodedBudget(budget, 2097152 + captureBytes)
  selectedLifetimes.assert(store, working, policy.expiresAt, policy.signal)
  const reservation = working.claim(2097152 + captureBytes)
  let live = true,
    consumed = false,
    asserted: Knex.Transaction | undefined,
    prior: Readonly<Descriptor> | undefined,
    output: Readonly<Descriptor> | undefined,
    maximumUpdatedAt: string | undefined,
    retained: Brc38StagingCleanupError | undefined
  const actor = (): void => {
      policy.signal?.throwIfAborted()
      if (
        !live ||
        storage.toDb() !== root ||
        privateNativeDatabaseIdentity(root)?.token !== origin.token ||
        Date.now() >= policy.expiresAt ||
        performance.now() >= deadline
      )
        invalid()
      store.assertPrivateNativeDestination(root)
    },
    source = async (trx: Knex.Transaction): Promise<void> => {
      actor()
      await verifyBrc38AuthenticatedSourceSeal(trx)
      if (!(await hasBrc38NativePackedTextSchema(trx))) invalid()
      const current = await readBrc38NativePackedTextDescriptor(trx, coordinate)
      if (prior === undefined || current?.bytes !== prior.bytes || current.sha256 !== prior.sha256) invalid()
      actor()
    },
    transaction = async <V>(readOnly: boolean, operation: (trx: Knex.Transaction) => Promise<V>): Promise<V> =>
      await store.withPrivateNativeDatabase(
        readOnly,
        async database =>
          await database.transaction(async trx => {
            actor()
            if (readOnly) store.assertPrivateNativeReadTransaction(trx)
            else store.assertPrivateNativeWriteTransaction(trx)
            await source(trx)
            const value = await operation(trx)
            await source(trx)
            actor()
            return value
          })
      ),
    version = async (trx: Knex.Transaction): Promise<Version> => {
      if (output === undefined) invalid()
      const rows: Version[] = await trx(names.versions)
        .where({ sha256: output.sha256 })
        .select('bytes', 'accepted', 'chunks', 'state')
        .limit(2)
      const row = rows[0]
      if (
        rows.length !== 1 ||
        row.bytes !== output.bytes ||
        !Number.isSafeInteger(row.accepted) ||
        row.accepted < 0 ||
        row.accepted > row.bytes ||
        !Number.isSafeInteger(row.chunks) ||
        row.chunks < 0 ||
        row.chunks > row.bytes ||
        !['PENDING', 'SEALED'].includes(row.state) ||
        (row.state === 'SEALED' && row.accepted !== row.bytes)
      )
        invalid()
      return row
    }
  const cleanupScope1 = new Brc38CleanupScope(() => {
    return promiseFromSync(() => {
      live = false
      if (retained !== undefined) {
        const failure = retained
        // Preserve the reservation with the concrete failed actor's cleanup.
        throw new Brc38StagingCleanupError(
          [failure],
          'Private checkpoint staging retains actual source/read cleanup',
          async () => {
            await failure.retryCleanup()
            reservation.close()
          }
        )
      }
      reservation.close()
    })
  })
  try {
    const delta = Object.freeze(
      deltas.map(value =>
        Object.freeze({
          entity: value.entity,
          count: value.count,
          done: value.done,
          maximumUpdatedAt:
            value.maximumUpdatedAt === undefined ? undefined : new Date(value.maximumUpdatedAt.getTime()),
          mappings: Object.freeze(
            value.mappings.map(mapping => Object.freeze({ incomingId: mapping.incomingId, localId: mapping.localId }))
          )
        })
      )
    )
    actor()
    const measured = await withBrc38PrivateCurrentCheckpointActor(
      store,
      storage,
      syncStateId,
      policy,
      delta,
      async chunks => {
        const hash = createHash('sha256'),
          utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        let bytes = 0
        for await (const chunk of chunks) {
          try {
            actor()
            if (
              !(chunk instanceof Uint8Array) ||
              chunk.length < 1 ||
              chunk.length > (policy.maximumReadBytes ?? 65536) ||
              chunk.length > policy.maximumCanonicalBytes - bytes
            )
              invalid()
            utf8.decode(chunk, { stream: true })
            hash.update(chunk)
            bytes += chunk.length
          } finally {
            if (chunk instanceof Uint8Array) chunk.fill(0)
          }
        }
        utf8.decode()
        actor()
        return Object.freeze({ bytes, sha256: hash.digest('hex') })
      }
    )
    prior = Object.freeze({ ...measured.prior })
    output = Object.freeze({ ...measured.value })
    maximumUpdatedAt = measured.maximumUpdatedAt
    if (output.bytes < 2) invalid()
    await transaction(false, async trx => {
      const existing = await trx(names.versions).where({ sha256: output!.sha256 }).first('sha256')
      if (existing === undefined)
        await trx(names.versions).insert({
          sha256: output!.sha256,
          bytes: output!.bytes,
          accepted: 0,
          chunks: 0,
          state: 'PENDING'
        })
      await version(trx)
      await selectedLifetimes.retain(trx, output!.sha256, budget)
    })
    const replay = await withBrc38PrivateCurrentCheckpointActor(
      store,
      storage,
      syncStateId,
      policy,
      delta,
      async (chunks, current) => {
        if (current.bytes !== prior!.bytes || current.sha256 !== prior!.sha256) invalid()
        const hash = createHash('sha256')
        let offset = 0
        for await (const supplied of chunks) {
          let bytes: Uint8Array | undefined
          try {
            actor()
            if (
              !(supplied instanceof Uint8Array) ||
              supplied.length < 1 ||
              supplied.length > Math.min(65536, policy.maximumReadBytes ?? 65536) ||
              supplied.length > output!.bytes - offset
            )
              invalid()
            bytes = supplied.slice()
            hash.update(bytes)
            const input = bytes
            await transaction(false, async trx => {
              const before = await version(trx)
              if (before.state === 'SEALED') return
              const retainedBytes = Math.min(input.length, Math.max(0, before.accepted - offset))
              for (let used = 0; used < retainedBytes;) {
                const at = offset + used,
                  row = (await trx(names.chunks)
                    .where({ sha256: output!.sha256 })
                    .where('offset', '<=', at)
                    .orderBy('offset', 'desc')
                    .first('offset', 'bytes', trx.raw('typeof(payload) AS kind,length(payload) AS actualBytes'))) as
                    { offset: number; bytes: number; kind: string; actualBytes: number } | undefined
                if (
                  row === undefined ||
                  !Number.isSafeInteger(row.offset) ||
                  row.offset < 0 ||
                  row.offset > at ||
                  !Number.isSafeInteger(row.bytes) ||
                  row.bytes < 1 ||
                  row.bytes > 65536 ||
                  row.kind !== 'blob' ||
                  row.actualBytes !== row.bytes ||
                  row.offset + row.bytes > before.accepted
                )
                  invalid()
                const within = at - row.offset,
                  length = Math.min(retainedBytes - used, row.bytes - within)
                if (length < 1) invalid()
                const previous = (await trx(names.chunks)
                  .where({ sha256: output!.sha256, offset: row.offset })
                  .first(trx.raw('substr(payload,?,?) AS payload', [within + 1, length]))) as
                  { payload: Uint8Array } | undefined
                try {
                  if (!(previous?.payload instanceof Uint8Array) || previous.payload.length !== length) invalid()
                  for (let index = 0; index < length; index++)
                    if (previous.payload[index] !== input[used + index]) invalid()
                } finally {
                  if (previous?.payload instanceof Uint8Array) previous.payload.fill(0)
                }
                used += length
              }
              if (retainedBytes < input.length) {
                if (before.accepted !== offset + retainedBytes) invalid()
                const captured = Buffer.from(input.subarray(retainedBytes))
                try {
                  await trx(names.chunks).insert({
                    sha256: output!.sha256,
                    offset: offset + retainedBytes,
                    bytes: captured.length,
                    payload: captured,
                    chunkSha256: digest(captured)
                  })
                } finally {
                  captured.fill(0)
                }
              }
            })
            offset += input.length
          } finally {
            bytes?.fill(0)
            if (supplied instanceof Uint8Array) supplied.fill(0)
          }
          actor()
          await new Promise<void>(resolve => setTimeout(resolve, 0))
        }
        if (offset !== output!.bytes || hash.digest('hex') !== output!.sha256) invalid()
      }
    )
    if (
      replay.maximumUpdatedAt !== maximumUpdatedAt ||
      replay.prior.bytes !== prior.bytes ||
      replay.prior.sha256 !== prior.sha256
    )
      invalid()
    // Both source actor pools have drained before this independent stored read.
    await transaction(true, async trx => {
      const before = await version(trx)
      if (
        before.accepted !== output!.bytes ||
        (await hashBrc38NativePackedTextVersion(
          trx,
          output!.sha256,
          output!.bytes,
          actor,
          Math.min(16384, policy.maximumReadBytes ?? 16384)
        )) !== output!.sha256
      )
        invalid()
    })
    await transaction(false, async trx => {
      const before = await version(trx)
      if (before.accepted !== output!.bytes) invalid()
      if (
        before.state === 'PENDING' &&
        (await trx(names.versions)
          .where({ sha256: output!.sha256, state: 'PENDING', accepted: output!.bytes, chunks: before.chunks })
          .update({ state: 'SEALED' })) !== 1
      )
        invalid()
    })
    const prepared: Readonly<Brc38PrivateCheckpointText> = Object.freeze({
      prior,
      output,
      ...(maximumUpdatedAt === undefined ? {} : { maximumUpdatedAt }),
      assert: (trx: Knex.Transaction) =>
        effects.run(async () => {
          actor()
          store.assertPrivateNativeWriteTransaction(trx)
          if (consumed || (asserted !== undefined && asserted !== trx) || !isBrc38OwnedPrivateNativeWriter(trx))
            invalid()
          await source(trx)
          if ((await version(trx)).state !== 'SEALED') invalid()
          asserted = trx
          actor()
        }),
      attach: (trx: Knex.Transaction) =>
        effects.run(async () => {
          actor()
          store.assertPrivateNativeWriteTransaction(trx)
          if (consumed || asserted !== trx || !isBrc38OwnedPrivateNativeWriter(trx)) invalid()
          consumed = true
          await verifyBrc38AuthenticatedSourceSeal(trx)
          if (!(await hasBrc38NativePackedTextSchema(trx)) || (await version(trx)).state !== 'SEALED') invalid()
          const row = (await trx('sync_states')
            .where({ syncStateId })
            .first(trx.raw('typeof(syncMap) AS kind,length(CAST(syncMap AS BLOB)) AS bytes'))) as
            { kind: string; bytes: number } | undefined
          if (row?.kind !== 'text' || row.bytes !== 0) invalid()
          const packet = brc38NativeTextCoordinate('syncStates', 'syncMap'),
            key = { tableId: packet[0], fieldId: packet[1], rowId: syncStateId },
            pointers: Array<{ sha256: string }> = await trx(names.fields).where(key).select('sha256').limit(2)
          if (pointers.length > 1 || (pointers.length === 1 && pointers[0].sha256 !== prior!.sha256)) invalid()
          await trx(names.fields).where(key).delete()
          await trx(names.fields).insert({ ...key, sha256: output!.sha256 })
          const actual = await readBrc38NativePackedTextDescriptor(trx, coordinate)
          if (actual?.bytes !== output!.bytes || actual.sha256 !== output!.sha256) invalid()
          actor()
        })
    })
    return await effects.retain(async () => await work(prepared))
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) retained = cause
    {
      await cleanupScope1.close()
      throw cause
    }
  } finally {
    await cleanupScope1.close()
  }
}
