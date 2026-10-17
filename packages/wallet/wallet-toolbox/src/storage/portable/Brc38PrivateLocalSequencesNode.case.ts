import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { Brc38PrivateLocalCandidate, type Brc38PrivateLocalCandidateOptions } from './Brc38PrivateLocalCandidateNode'
import type { Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual private local allocation history differs from the independent fixture')
}
/** UNRUN. Real finite already-caught-up private candidate and genuine original
 * source. Expectations are independent AUTOINCREMENT histories containing a
 * deleted high ID; they must not be regenerated from the source under test. */
export async function verifyBrc38PrivateLocalAllocationHistory(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  options: Brc38PrivateLocalCandidateOptions,
  expected: readonly Readonly<{ table: Brc38NativeLocalBaselineTable; sequence: string | null }>[],
  check: () => void
): Promise<void> {
  requireCase(
    expected.length > 0 &&
      expected.length <= 47 &&
      expected.some(row => row.sequence !== null && BigInt(row.sequence) >= 100n)
  )
  const owned = options.workingAllocation.used
  await Brc38PrivateLocalCandidate.with(store, source, options, async candidate => {
    const receipt = await candidate.copySequences(),
      replay = await candidate.copySequences()
    requireCase(receipt.tables === expected.length && JSON.stringify(receipt) === JSON.stringify(replay))
    await store.withPrivateNativeDatabase(
      true,
      async database =>
        await database.transaction(async trx => {
          store.assertPrivateNativeReadTransaction(trx)
          for (const row of expected) {
            check()
            const actual = (await trx('sqlite_sequence')
              .where({ name: row.table })
              .select(trx.raw('CAST(seq AS TEXT) AS value'))
              .limit(2)) as Array<{ value: string }>
            requireCase(
              row.sequence === null ? actual.length === 0 : actual.length === 1 && actual[0].value === row.sequence
            )
          }
        })
    )
  })
  requireCase(options.workingAllocation.used === owned)
  check()
}

/** A separate genuine fixture has a greater candidate counter than its actual
 * source. Allocation history cannot regress merely because rows were deleted.
 * This case intentionally poisons/drains its failed source callback; the
 * owning fixture opens another actual source for any subsequent work. */
export async function verifyBrc38PrivateLocalAllocationRegressionRefusal(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  options: Brc38PrivateLocalCandidateOptions,
  selectedTable: Brc38NativeLocalBaselineTable,
  greaterSequence: string,
  check: () => void
): Promise<void> {
  requireCase(/^[1-9]\d{0,15}$/.test(greaterSequence) && BigInt(greaterSequence) <= 9007199254740991n)
  let refused = false,
    expectedFailure: unknown
  await Brc38PrivateLocalCandidate.with(store, source, options, async candidate => {
    await store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async trx => {
          store.assertPrivateNativeWriteTransaction(trx)
          requireCase(
            (await trx('sqlite_sequence')
              .where({ name: selectedTable })
              .update({ seq: trx.raw('CAST(? AS INTEGER)', [greaterSequence]) })) === 1
          )
        })
    )
    try {
      await candidate.copySequences()
    } catch (cause) {
      requireCase(
        cause instanceof Error &&
          cause.message ===
            'Private local allocation history differs from the original source, actual candidate or complete copy'
      )
      refused = true
      expectedFailure = cause
    }
  }).catch(cause => {
    requireCase(refused && cause === expectedFailure)
  })
  requireCase(refused)
  // Rollback preserves the greater counter and does not rewrite it to max(rowid).
  await store.withAuthenticatedPrivateStructuredDestination(async () => {
    await store.withPrivateNativeDatabase(
      true,
      async database =>
        await database.transaction(async trx => {
          store.assertPrivateNativeReadTransaction(trx)
          const row = (await trx('sqlite_sequence')
            .where({ name: selectedTable })
            .first(trx.raw('CAST(seq AS TEXT) AS value'))) as { value: string } | undefined
          requireCase(row?.value === greaterSequence)
        })
    )
  })
  check()
}
