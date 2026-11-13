import type { Brc38PrivateLocalCandidate } from './Brc38PrivateLocalCandidateNode'
interface ActualController {
  withCandidate<T>(work: (candidate: Brc38PrivateLocalCandidate) => Promise<T>): Promise<T>
  /** Use actual SQL/packed writers to replace one valid same-length field,
   * change scalar metadata, remove a row or add an extra valid row. Leave
   * candidate point hashes unchanged. Each case uses a separate fresh fixture. */
  changeCandidate(): Promise<void>
  readonly workingUsed: () => number
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual private baseline inventory case differs')
}
function mismatch(value: unknown, depth = 0): boolean {
  if (depth > 16 || !(value instanceof Error)) return false
  return (
    value.message ===
      'Private local baseline inventory differs from actual source metadata, keys, logical bytes or relationships' ||
    mismatch(value.cause, depth + 1) ||
    (value instanceof AggregateError && value.errors.some(error => mismatch(error, depth + 1)))
  )
}
/** Finite genuine already copied all47 candidate and source, independent rows
 * and byte totals authored before construction. The second comparison must
 * reject a real postimage change despite unchanged point/SHA progress DATA.
 * No complete merge, publication or primary readiness is supplied. */
export async function verifyBrc38PrivateLocalBaselineInventory(
  controller: ActualController,
  expected: Readonly<{ rows: number; logicalBytes: string }>
): Promise<void> {
  requireCase(
    Number.isSafeInteger(expected.rows) &&
      expected.rows > 0 &&
      expected.rows <= 128 &&
      /^(?:0|[1-9]\d{0,6})$/.test(expected.logicalBytes) &&
      BigInt(expected.logicalBytes) <= 1048576n
  )
  const used = controller.workingUsed()
  await controller.withCandidate(async candidate => {
    const first = await candidate.inspectBaseline(),
      again = await candidate.inspectBaseline()
    requireCase(
      first.rows === expected.rows &&
        first.logicalBytes === expected.logicalBytes &&
        JSON.stringify(first) === JSON.stringify(again)
    )
    controller.check()
  })
  requireCase(controller.workingUsed() === used)
  await controller.changeCandidate()
  let refused = false
  try {
    await controller.withCandidate(async candidate => {
      await candidate.inspectBaseline()
    })
  } catch (cause) {
    refused = mismatch(cause)
  }
  requireCase(refused && controller.workingUsed() === used)
  controller.check()
}
