import { hasBrc38NativePackedSchema, nativePackedTables } from './Brc38NativePackedSchemaNode'
import { hashBrc38NativePackedVersion } from './Brc38NativePackedFieldsNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeSqlite } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { hasBrc38NativePackedTextSchema, nativePackedTextTables } from './Brc38NativePackedTextSchemaNode'
import { hashBrc38NativePackedTextVersion } from './Brc38NativePackedTextFieldsNode'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { chargeBrc38ImportDecodedBudget, type Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'

export interface Brc38PrivateContentDescriptor {
  readonly bytes: number
  readonly sha256: string
}
interface Version {
  bytes: number
  accepted: number
  chunks: number
  state: string
}
export interface Brc38PrivateContentVersion {
  begin(descriptor: Readonly<Brc38PrivateContentDescriptor>): Promise<void>
  append(offset: number, bytes: Uint8Array): Promise<void>
  finish(): Promise<Readonly<Brc38PrivateContentDescriptor>>
}
function invalid(): never {
  throw new Error('Private content staging differs from its actual owner, content prefix or original bounds')
}

/** Internal content staging only, with no source/semantic/row/receipt authority.
 * Concrete producers separately own actual archive/current reads and complete
 * grammar/merge policy. Raw local TEXT and BLOBs explicitly accept empty or
 * one-byte content; structured archive producers keep their minimum of two. This primitive reserves charged PENDING content,
 * compares interrupted prefixes, independently hashes complete stored bytes,
 * and seals through short transactions. Final row effects must still prove
 * original/current/journal/primary admission; a descriptor is only DATA. */
export async function withBrc38PrivateContentVersion<T>(
  format: 'binary' | 'raw-text' | 'structured-text',
  store: KnexBrc38StagingStore,
  policy: Readonly<{
    expiresAt: number
    maximumBytes: number
    maximumVersions?: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>,
  budget: Brc38ImportDecodedBudget,
  work: (version: Readonly<Brc38PrivateContentVersion>) => Promise<T>,
  borrowedReadDatabase?: Knex,
  selectedLifetimes?: Brc38PrivateDerivedTextLifetimes
): Promise<T> {
  if (format !== 'binary' && format !== 'raw-text' && format !== 'structured-text') invalid()
  if (selectedLifetimes === undefined)
    return await Brc38PrivateDerivedTextLifetimes.with(
      store,
      policy,
      async lifetimes =>
        await withBrc38PrivateContentVersion(format, store, policy, budget, work, borrowedReadDatabase, lifetimes)
    )
  const family = format === 'binary' ? 'binary' : 'text',
    minimumBytes = format === 'structured-text' ? 2 : 0,
    names = family === 'binary' ? nativePackedTables : nativePackedTextTables,
    hasSchema = family === 'binary' ? hasBrc38NativePackedSchema : hasBrc38NativePackedTextSchema,
    hashVersion = family === 'binary' ? hashBrc38NativePackedVersion : hashBrc38NativePackedTextVersion,
    root = store.knex,
    origin = privateNativeDatabaseIdentity(root),
    expiresAt = policy.expiresAt,
    maximumBytes = policy.maximumBytes,
    maximumVersions = policy.maximumVersions ?? 1,
    signal = policy.signal,
    working = brc38WorkingAllocation(policy.workingAllocation),
    deadline = performance.now() + Math.max(0, expiresAt - Date.now()),
    io = new Brc38OwnedImportReads()
  if (
    origin?.slot !== 0 ||
    working === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > store.operationExpiresAt ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < minimumBytes ||
    maximumBytes > 1000000000 ||
    !Number.isSafeInteger(maximumVersions) ||
    maximumVersions < 1 ||
    maximumVersions > (format === 'structured-text' ? 4 : 32) ||
    budget.signal !== signal ||
    !Number.isSafeInteger(budget.maximum) ||
    budget.maximum > store.limits.maximumRowAllocationBytes ||
    (borrowedReadDatabase !== undefined &&
      (privateNativeDatabaseIdentity(borrowedReadDatabase)?.slot !== 3 ||
        privateNativeDatabaseIdentity(borrowedReadDatabase)?.token !== origin.token ||
        !isBrc38OwnedPrivateNativeSqlite(borrowedReadDatabase)))
  )
    invalid()
  selectedLifetimes.assert(store, working, expiresAt, signal)
  chargeBrc38ImportDecodedBudget(budget, 2097152)
  const reservation = working.claim(2097152)
  let live = true,
    expected: Readonly<Brc38PrivateContentDescriptor> | undefined,
    offset = 0,
    finished = false,
    versions = 0,
    retained: Brc38StagingCleanupError | undefined
  let replay = createHash('sha256'),
    utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const check = (): void => {
      signal?.throwIfAborted()
      if (
        !live ||
        store.knex !== root ||
        privateNativeDatabaseIdentity(root)?.token !== origin.token ||
        Date.now() >= expiresAt ||
        performance.now() >= deadline
      )
        invalid()
      store.assertPrivateNativeDestination(root)
    },
    transaction = async <V>(readOnly: boolean, operation: (trx: Knex.Transaction) => Promise<V>): Promise<V> => {
      const execute = async (database: Knex): Promise<V> =>
        await database.transaction(async trx => {
          check()
          if (readOnly) store.assertPrivateNativeReadTransaction(trx)
          else store.assertPrivateNativeWriteTransaction(trx)
          await verifyBrc38AuthenticatedSourceSeal(trx)
          if (!(await hasSchema(trx))) invalid()
          const result = await operation(trx)
          check()
          return result
        })
      return readOnly && borrowedReadDatabase !== undefined
        ? await execute(borrowedReadDatabase)
        : await store.withPrivateNativeDatabase(readOnly, execute)
    },
    current = async (trx: Knex.Transaction): Promise<Version> => {
      if (expected === undefined) invalid()
      const rows: Version[] = await trx(names.versions)
          .where({ sha256: expected.sha256 })
          .select('bytes', 'accepted', 'chunks', 'state')
          .limit(2),
        row = rows[0]
      if (
        rows.length !== 1 ||
        row.bytes !== expected.bytes ||
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
  let outcome: { value: T } | { cause: unknown }
  try {
    const version: Readonly<Brc38PrivateContentVersion> = Object.freeze<Brc38PrivateContentVersion>({
      begin: descriptor => {
        check()
        const captured = Object.freeze({ bytes: descriptor.bytes, sha256: descriptor.sha256 })
        return io.run(async () => {
          check()
          if (
            (expected !== undefined && !finished) ||
            versions >= maximumVersions ||
            !Number.isSafeInteger(captured.bytes) ||
            captured.bytes < minimumBytes ||
            captured.bytes > maximumBytes ||
            typeof captured.sha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(captured.sha256)
          )
            invalid()
          versions++
          offset = 0
          finished = false
          replay = createHash('sha256')
          utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
          expected = captured
          await transaction(false, async trx => {
            if ((await trx(names.versions).where({ sha256: expected!.sha256 }).first('sha256')) === undefined)
              await trx(names.versions).insert({
                sha256: expected!.sha256,
                bytes: expected!.bytes,
                accepted: 0,
                chunks: 0,
                state: 'PENDING'
              })
            await current(trx)
            await selectedLifetimes.retain(trx, expected!.sha256, budget, family)
          })
        })
      },
      append: (at, supplied) => {
        check()
        if (!(supplied instanceof Uint8Array) || supplied.length < 1 || supplied.length > 65536) invalid()
        // Capture the finite DATA before the owned I/O microtask is queued.
        // Caller mutation cannot alter this append or its interrupted prefix.
        const bytes = detachBrc38PrivateChunk(supplied, 65536)
        return io
          .run(async () => {
            check()
            if (finished || expected === undefined || at !== offset || bytes.length > expected.bytes - offset) invalid()
            try {
              replay.update(bytes)
              if (family === 'text') utf8.decode(bytes, { stream: true })
              await transaction(false, async trx => {
                const before = await current(trx)
                if (before.state === 'SEALED') return
                const retained = Math.min(bytes.length, Math.max(0, before.accepted - offset))
                for (let used = 0; used < retained;) {
                  const position = offset + used,
                    row = (await trx(names.chunks)
                      .where({ sha256: expected!.sha256 })
                      .where('offset', '<=', position)
                      .orderBy('offset', 'desc')
                      .first('offset', 'bytes', trx.raw('typeof(payload) AS kind,length(payload) AS actualBytes'))) as
                      { offset: number; bytes: number; kind: string; actualBytes: number } | undefined
                  if (
                    row === undefined ||
                    !Number.isSafeInteger(row.offset) ||
                    row.offset < 0 ||
                    row.offset > position ||
                    !Number.isSafeInteger(row.bytes) ||
                    row.bytes < 1 ||
                    row.bytes > 65536 ||
                    row.kind !== 'blob' ||
                    row.actualBytes !== row.bytes ||
                    row.offset + row.bytes > before.accepted
                  )
                    invalid()
                  const start = position - row.offset,
                    amount = Math.min(retained - used, row.bytes - start)
                  if (amount < 1) invalid()
                  const prior = (await trx(names.chunks)
                    .where({ sha256: expected!.sha256, offset: row.offset })
                    .first(trx.raw('substr(payload,?,?) AS payload', [start + 1, amount]))) as
                    { payload: Uint8Array } | undefined
                  try {
                    if (!(prior?.payload instanceof Uint8Array) || prior.payload.length !== amount) invalid()
                    for (let index = 0; index < amount; index++)
                      if (prior.payload[index] !== bytes[used + index]) invalid()
                  } finally {
                    if (prior?.payload instanceof Uint8Array) prior.payload.fill(0)
                  }
                  used += amount
                }
                if (retained < bytes.length) {
                  if (before.accepted !== offset + retained) invalid()
                  const captured = Buffer.from(bytes.subarray(retained))
                  try {
                    await trx(names.chunks).insert({
                      sha256: expected!.sha256,
                      offset: offset + retained,
                      bytes: captured.length,
                      payload: captured,
                      chunkSha256: createHash('sha256').update(captured).digest('hex')
                    })
                  } finally {
                    captured.fill(0)
                  }
                }
              })
              offset += bytes.length
              check()
            } finally {
              bytes.fill(0)
            }
          })
          .finally(() => bytes.fill(0))
      },
      finish: () =>
        io.run(async () => {
          check()
          if (finished || expected === undefined || offset !== expected.bytes) invalid()
          if (family === 'text') utf8.decode()
          if (replay.digest('hex') !== expected.sha256) invalid()
          await transaction(true, async trx => {
            if (
              (await current(trx)).accepted !== expected!.bytes ||
              (await hashVersion(trx, expected!.sha256, expected!.bytes, check, 16384, working)) !== expected!.sha256
            )
              invalid()
          })
          await transaction(false, async trx => {
            const before = await current(trx)
            if (before.accepted !== expected!.bytes) invalid()
            if (
              before.state === 'PENDING' &&
              (await trx(names.versions)
                .where({ sha256: expected!.sha256, state: 'PENDING', accepted: before.accepted, chunks: before.chunks })
                .update({ state: 'SEALED' })) !== 1
            )
              invalid()
          })
          finished = true
          check()
          return expected
        })
    })
    outcome = { value: await io.retain(async () => await work(version)) }
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) retained = cause
    outcome = { cause }
  }
  live = false
  if (retained !== undefined) {
    const failure = retained
    throw new Brc38StagingCleanupError(
      [failure],
      'Private content retains its physical read cleanup and working reservation',
      async () => {
        await failure.retryCleanup()
        reservation.close()
      }
    )
  }
  reservation.close()
  if ('cause' in outcome) throw outcome.cause
  return outcome.value
}
