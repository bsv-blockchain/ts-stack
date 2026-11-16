import { nativeTestExecutable } from './Brc38NativeTestPath'
import createKnex, { type Knex } from 'knex'
import { join } from 'node:path'
import { withComposedNativeFixture } from './Brc38ComposedNativeFixture'
import { seedComposedAuxiliaryFixture } from './Brc38ComposedAuxiliaryFixture'
import { captureComposedSemanticFixture, withComposedFixtureRead } from './Brc38ComposedSemanticFixture'
import {
  readIndependentNativeInventory,
  wipeIndependentNativeInventory
} from './Brc38IndependentNativeInventoryFixture'
import { nativeMergeExpectedFixture } from './Brc38NativeMergeExpectedFixture'
import { authenticatedStagePassword } from './Brc38AuthenticatedPrivateStageFixture'
import {
  mergeAuthenticatedBrc39NativeInactive,
  Brc38AuthenticatedNativeMergeInterruptedError,
  type Brc38AuthenticatedNativeMergeOptions
} from './Brc38AuthenticatedNativeMergeNode'
import { brc38StagingBinding } from './Brc38StagingBinding'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'

// The initial full workflow consumed its 540-second owner during inventory.
// Admit that measured window twice for initial merge and repeat/resume, plus
// 120 seconds for independent inventory and custody checks. One finite owner;
// all six variants, data/assertions and production/default ceilings remain.
const nativeFixtureLifetimeMs = 540000 + 540000 + 120000
const nativeFixtureCaseTimeoutMs = nativeFixtureLifetimeMs + 30000

type Fixture = Parameters<Parameters<typeof withComposedNativeFixture>[0]>[0]

async function* chunks(bytes: Uint8Array, width = 1024): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += width) yield bytes.slice(offset, offset + width)
}

/** Each observation reopens the actual reservation after the public API has
 * returned and physically drained its private owner. No retained facade or
 * previously observed close flag supplies admission to the new owner. */
async function readPrivate<T>(
  fixture: Fixture,
  id: string,
  work: (trx: Knex.Transaction, store: KnexBrc38StagingStore) => Promise<T>
): Promise<T> {
  fixture.check()
  const reservation = await fixture.admission.resumeNative(
    id,
    fixture.source.limits,
    fixture.source.binding,
    fixture.executable
  )
  fixture.retainCleanup(async () => await reservation.store.close())
  try {
    return await reservation.store.withAuthenticatedPrivateStructuredDestination(
      async () =>
        await reservation.store.withPrivateNativeDatabase(
          true,
          async database =>
            await database.transaction(async trx => {
              reservation.store.assertPrivateNativeReadTransaction(trx)
              const value = await work(trx, reservation.store)
              fixture.check()
              return value
            })
        )
    )
  } finally {
    await reservation.store.close()
  }
}

async function readCustody(fixture: Fixture, id: string): Promise<unknown> {
  // The fixture-created catalogue is read through an independent readonly
  // stock connection after the controller drains. These are custody data;
  // they never authorize a native owner, profile or publication.
  const catalogue = createKnex({
    client: 'better-sqlite3',
    useNullAsDefault: true,
    connection: { filename: join(fixture.admission.directory, 'brc38-admission.sqlite'), options: { readonly: true } },
    pool: { min: 0, max: 1 }
  })
  fixture.retainCleanup(async () => await catalogue.destroy())
  let reservation: unknown
  try {
    const sizes = (await catalogue('reservations')
      .where({ id })
      .select(catalogue.raw('length(id)+length(digest)+length(state) AS bytes'))
      .limit(2)) as Array<{ bytes: number }>
    expect(sizes).toHaveLength(1)
    expect(sizes[0].bytes).toBeLessThanOrEqual(128)
    const rows = await catalogue('reservations')
      .where({ id })
      .select('id', 'digest', 'expiresAt', 'maximumPhysicalBytes', 'maximumLogicalBytes', 'state')
      .limit(2)
    expect(rows).toHaveLength(1)
    reservation = rows[0]
  } finally {
    await catalogue.destroy()
  }
  return {
    reservation,
    usage: await fixture.admission.usage(),
    private: await readPrivate(fixture, id, async trx => {
      const sizes = (await trx('brc38_import_journal')
        .select(trx.raw('length(admissionJson)+length(receiptJson) AS bytes'))
        .limit(5)) as Array<{ bytes: number }>
      expect(sizes.length).toBeLessThanOrEqual(4)
      for (const value of sizes) expect(value.bytes).toBeLessThanOrEqual(516096)
      const journals = await trx('brc38_import_journal')
          .select('importId', 'admissionJson', 'receiptJson', 'mappedIds')
          .orderBy('importId')
          .limit(5),
        ranges = await trx('brc38_private_incoming_id_ranges')
          .select('tableId', 'first', 'count', 'used')
          .orderBy('tableId')
          .limit(11)
      expect(ranges).toHaveLength(10)
      return { journals, ranges }
    })
  }
}

async function sourceRanges(fixture: Fixture): Promise<unknown> {
  const digest = brc38StagingBinding(fixture.source.binding, fixture.source.limits).digest
  return await withComposedFixtureRead(fixture.manager, async trx => {
    const ranges = await trx('brc38_incoming_id_ranges')
      .where({ bindingSha256: digest })
      .select('bindingSha256', 'tableId', 'sourceEpoch', 'primaryEpoch', 'userId', 'first', 'count', 'expiresAt')
      .orderBy('tableId')
      .limit(11)
    expect(ranges).toHaveLength(10)
    for (const row of ranges) {
      expect(row.first).toBeGreaterThan(0)
      expect(row.count).toBeGreaterThan(0)
      expect(row.expiresAt).toBe(fixture.expiresAt)
    }
    const counters = await trx('sqlite_sequence').select('name', 'seq').orderBy('name').limit(65)
    expect(counters.length).toBeLessThanOrEqual(64)
    return { ranges, counters }
  })
}

function options(fixture: Fixture): Brc38AuthenticatedNativeMergeOptions {
  return {
    storage: fixture.storage,
    admission: fixture.admission,
    source: fixture.source,
    merge: fixture.merge,
    executable: fixture.executable,
    maximumOperations: 4096
  }
}

/** UNRUN public entry-point cases. The whole47 expected graph is declared
 * from the separately captured serving-source preimage before import. */
test.each(['repeat', 'lost-observer', 'wrong-password', 'truncated', 'corrupt', 'wrong-binding'] as const)(
  'authenticated native entry point automatically reserves IDs and preserves original custody: %s',
  async variant => {
    await withComposedNativeFixture(
      async fixture => {
        await seedComposedAuxiliaryFixture(fixture.storage, fixture.manager)
        const initial = await withComposedFixtureRead(fixture.manager, readIndependentNativeInventory),
          before = await captureComposedSemanticFixture(fixture.manager),
          expected = nativeMergeExpectedFixture(initial, before, fixture.incomingData),
          selected = options(fixture),
          sentinel = new Error('Independent public observer ACK loss')
        const started = performance.now(),
          phases = new Map<string, { operations: number; milliseconds: number; longestMilliseconds: number }>()
        let id: string | undefined,
          lost = false,
          lastOperation = 0,
          lastElapsedMilliseconds = 0,
          authenticatedMilliseconds: number | undefined
        try {
          let result
          try {
            result = await mergeAuthenticatedBrc39NativeInactive(fixture.chunks(), authenticatedStagePassword, {
              ...selected,
              progress: value => {
                fixture.check()
                id = value.reservationId
                // The observer cannot asynchronously acquire a scope. The
                // runner contract separately probes its read slots after each
                // operation; this public case checks actual reopen below.
                expect(fixture.merge.workingAllocation.used).toBe(0)
                if (value.phase === 'AUTHENTICATED') authenticatedMilliseconds = performance.now() - started
                if (value.operation !== undefined) {
                  const operation = value.operation,
                    milliseconds = operation.elapsedMilliseconds - lastElapsedMilliseconds,
                    phase = operation.progress.phase,
                    totals = phases.get(phase) ?? { operations: 0, milliseconds: 0, longestMilliseconds: 0 }
                  totals.operations++
                  totals.milliseconds += milliseconds
                  totals.longestMilliseconds = Math.max(totals.longestMilliseconds, milliseconds)
                  phases.set(phase, totals)
                  lastOperation = operation.operation
                  lastElapsedMilliseconds = operation.elapsedMilliseconds
                }
                if (
                  variant === 'lost-observer' &&
                  value.phase === 'MERGE' &&
                  (value.operation?.progress.phase === 'IMPORT' ||
                    value.operation?.progress.phase === 'INVENTORY_REQUIRED')
                ) {
                  lost = true
                  throw sentinel
                }
              }
            })
          } catch (cause) {
            if (variant !== 'lost-observer' || !lost) {
              // Fixed phase counters retain no wallet data or operation list.
              // Preserve the actual failure, owner, corpus and finite limits.
              console.info('BRC38_AUTHENTICATED_MERGE_TIMING', {
                variant,
                elapsedMilliseconds: performance.now() - started,
                authenticatedMilliseconds,
                lastOperation,
                lastElapsedMilliseconds,
                remainingOriginalLifetimeMilliseconds: fixture.source.limits.expiresAt - Date.now(),
                phases: Object.fromEntries(phases)
              })
              throw cause
            }
            expect(variant).toBe('lost-observer')
            expect(lost).toBe(true)
            expect(cause).toBeInstanceOf(Brc38AuthenticatedNativeMergeInterruptedError)
            expect((cause as Brc38AuthenticatedNativeMergeInterruptedError).cause).toBe(sentinel)
            expect((cause as Brc38AuthenticatedNativeMergeInterruptedError).reservationId).toBe(id)
          }
          expect(id).toBeDefined()
          if (id === undefined) throw new Error('Public controller omitted its actual reservation')
          const reserved = await sourceRanges(fixture)
          if (result === undefined)
            result = await mergeAuthenticatedBrc39NativeInactive(chunks(fixture.bytes), authenticatedStagePassword, {
              ...selected,
              source: { ...fixture.source, reservationId: id }
            })
          expect(result.inactive).toBe(true)
          expect(result.reservationId).toBe(id)
          const actual = await readPrivate(fixture, id, async trx => await readIndependentNativeInventory(trx))
          try {
            expect(actual).toEqual(expected)
          } finally {
            wipeIndependentNativeInventory(actual)
          }
          expect(await sourceRanges(fixture)).toEqual(reserved)
          const custody = await readCustody(fixture, id),
            source = await withComposedFixtureRead(fixture.manager, readIndependentNativeInventory)
          try {
            expect(source).toEqual(initial)
            if (variant === 'repeat' || variant === 'lost-observer') {
              expect(
                await mergeAuthenticatedBrc39NativeInactive(chunks(fixture.bytes), authenticatedStagePassword, {
                  ...selected,
                  source: { ...fixture.source, reservationId: id }
                })
              ).toEqual(result)
            } else {
              const bytes = fixture.bytes.slice(),
                password = variant === 'wrong-password' ? 'independent incorrect password' : authenticatedStagePassword
              if (variant === 'corrupt') bytes[bytes.length - 1] ^= 1
              const sourceOptions = {
                ...fixture.source,
                reservationId: id,
                ...(variant === 'wrong-binding'
                  ? { binding: { ...fixture.source.binding, targetStorageIdentityKey: 'independent wrong target' } }
                  : {})
              }
              try {
                await expect(
                  mergeAuthenticatedBrc39NativeInactive(
                    chunks(variant === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes),
                    password,
                    { ...selected, source: sourceOptions }
                  )
                ).rejects.toMatchObject({
                  name: 'Brc38AuthenticatedNativeMergeInterruptedError',
                  reservationId: id
                })
              } finally {
                bytes.fill(0)
              }
            }
            expect(await readCustody(fixture, id)).toEqual(custody)
            expect(await sourceRanges(fixture)).toEqual(reserved)
            const candidate = await readPrivate(fixture, id, async trx => await readIndependentNativeInventory(trx)),
              serving = await withComposedFixtureRead(fixture.manager, readIndependentNativeInventory)
            try {
              expect(candidate).toEqual(expected)
              expect(serving).toEqual(source)
            } finally {
              wipeIndependentNativeInventory(candidate)
              wipeIndependentNativeInventory(serving)
            }
            expect(fixture.merge.workingAllocation.used).toBe(0)
            fixture.check()
          } finally {
            wipeIndependentNativeInventory(source)
          }
        } finally {
          wipeIndependentNativeInventory(initial)
          wipeIndependentNativeInventory(expected)
        }
      },
      nativeTestExecutable(),
      (_source, incoming) => {
        incoming.tables.transactions[0].description = 'independent public import\u0000雪😀'.repeat(1000)
        incoming.tables.transactions[0].updated_at = '2026-10-04T00:00:00.000Z'
      },
      nativeFixtureLifetimeMs
    )
  },
  nativeFixtureCaseTimeoutMs
)
