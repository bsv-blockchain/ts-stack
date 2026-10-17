import { createHash } from 'node:crypto'
import {
  mergeAuthenticatedBrc39NativeInactive,
  Brc38AuthenticatedNativeMergeInterruptedError,
  type Brc38AuthenticatedNativeMergeOptions,
  type Brc38AuthenticatedNativeMergeResult
} from './Brc38AuthenticatedNativeMergeNode'
import { brc38NativeLocalBaselineTables, type Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import type { IndependentLocalCandidateRow } from './Brc38PrivateLocalCandidateNode.case'

type Inventory = Readonly<Record<Brc38NativeLocalBaselineTable, readonly IndependentLocalCandidateRow[]>>
interface ActualController {
  readonly options: Brc38AuthenticatedNativeMergeOptions
  readonly encrypted: Uint8Array
  readonly password: string
  /** These readers acquire genuine separate owners after the API has drained,
   * and compare actual typed metadata and COMPLETE payloads, not point hashes. */
  readCandidate(reservationId: string): Promise<Inventory>
  readCustody(reservationId: string): Promise<unknown>
  readServingSource(): Promise<Inventory>
  assertOwnersDrained(): Promise<void>
  assertProgressReadScopesDrained(): void
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent authenticated native merge integration case differs')
}
function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') }
  if (typeof value === 'bigint') return { integer: value.toString() }
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, child]) => [name, normalize(child)])
    )
  return value
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}
async function* encrypted(controller: ActualController, width: number): AsyncGenerator<Uint8Array> {
  requireCase(controller.encrypted.length >= 96 && controller.encrypted.length <= 1048576)
  for (let offset = 0; offset < controller.encrypted.length; offset += width) {
    controller.check()
    yield controller.encrypted.slice(offset, offset + width)
  }
}
async function assertComplete(
  controller: ActualController,
  result: Readonly<Brc38AuthenticatedNativeMergeResult>,
  expected: Inventory
): Promise<void> {
  let rows = 0,
    bytes = 0
  for (const table of brc38NativeLocalBaselineTables) {
    requireCase(Array.isArray(expected[table]))
    rows += expected[table].length
    for (const row of expected[table])
      for (const value of Object.values(row.fields)) {
        requireCase(value === null || value instanceof Uint8Array)
        bytes += value?.length ?? 0
      }
  }
  requireCase(
    rows <= 128 &&
      bytes <= 1048576 &&
      result.inactive === true &&
      result.inventory.rows === rows &&
      result.inventory.logicalBytes === String(bytes) &&
      result.archiveSha256 === createHash('sha256').update(controller.encrypted).digest('hex')
  )
  const actual = await controller.readCandidate(result.reservationId)
  for (const table of brc38NativeLocalBaselineTables) {
    const ordered = (values: readonly IndependentLocalCandidateRow[]) => [...values].sort((a, b) => a.rowId - b.rowId)
    requireCase(same(ordered(actual[table]), ordered(expected[table])))
  }
  await controller.assertOwnersDrained()
  controller.check()
}
/** UNRUN genuine complete envelope and occupied original source fixture. This
 * drives the public Node entry point, actual stock-to-native handoff, complete
 * composition and repeat reauthentication with different cipher boundaries. */
export async function verifyBrc38AuthenticatedNativeMerge(
  controller: ActualController,
  expected: Inventory
): Promise<void> {
  const source = await controller.readServingSource(),
    used = controller.options.merge.workingAllocation.used,
    result = await mergeAuthenticatedBrc39NativeInactive(encrypted(controller, 16384), controller.password, {
      ...controller.options,
      progress: () => controller.assertProgressReadScopesDrained()
    })
  await assertComplete(controller, result, expected)
  requireCase(
    same(await controller.readServingSource(), source) && controller.options.merge.workingAllocation.used === used
  )
  const custody = await controller.readCustody(result.reservationId),
    repeated = await mergeAuthenticatedBrc39NativeInactive(encrypted(controller, 4093), controller.password, {
      ...controller.options,
      source: { ...controller.options.source, reservationId: result.reservationId },
      progress: () => controller.assertProgressReadScopesDrained()
    })
  await assertComplete(controller, repeated, expected)
  requireCase(
    same(repeated, result) &&
      same(await controller.readCustody(result.reservationId), custody) &&
      same(await controller.readServingSource(), source) &&
      controller.options.merge.workingAllocation.used === used
  )
}
/** A rejected full-envelope attempt must not delete or rewrite the genuine
 * existing candidate/custody, release its catalog charge or renew its expiry.
 * Invoke with wrong password, truncated/corrupt envelopes and wrong binding
 * on isolated instances. The controller's custody includes reservation limits. */
export async function verifyBrc38AuthenticatedNativeMergeRejectedResume(
  controller: ActualController,
  reservationId: string,
  rejectedSource: AsyncIterable<Uint8Array>,
  rejectedPassword: string
): Promise<void> {
  const source = await controller.readServingSource(),
    candidate = await controller.readCandidate(reservationId),
    custody = await controller.readCustody(reservationId),
    used = controller.options.merge.workingAllocation.used
  let rejected = false
  try {
    await mergeAuthenticatedBrc39NativeInactive(rejectedSource, rejectedPassword, {
      ...controller.options,
      source: { ...controller.options.source, reservationId }
    })
  } catch (cause) {
    requireCase(cause instanceof Brc38AuthenticatedNativeMergeInterruptedError && cause.reservationId === reservationId)
    rejected = true
  }
  requireCase(
    rejected &&
      same(await controller.readCustody(reservationId), custody) &&
      same(await controller.readCandidate(reservationId), candidate) &&
      same(await controller.readServingSource(), source) &&
      controller.options.merge.workingAllocation.used === used
  )
  await controller.assertOwnersDrained()
  controller.check()
}
/** Lose the UI acknowledgement after a real acknowledged import operation.
 * The next API invocation authenticates the original full envelope and reads
 * actual committed destination state; it cannot restart the import journal. */
export async function verifyBrc38AuthenticatedNativeMergeLostObserver(
  controller: ActualController,
  expected: Inventory
): Promise<void> {
  let reservationId: string | undefined,
    lost = false
  const sentinel = new Error('Independent observer acknowledgement loss')
  try {
    await mergeAuthenticatedBrc39NativeInactive(encrypted(controller, 16384), controller.password, {
      ...controller.options,
      progress: value => {
        controller.assertProgressReadScopesDrained()
        reservationId = value.reservationId
        if (
          value.phase === 'MERGE' &&
          (value.operation?.progress.phase === 'IMPORT' || value.operation?.progress.phase === 'INVENTORY_REQUIRED')
        ) {
          lost = true
          throw sentinel
        }
      }
    })
  } catch (cause) {
    requireCase(
      cause instanceof Brc38AuthenticatedNativeMergeInterruptedError &&
        cause.cause === sentinel &&
        cause.reservationId === reservationId &&
        lost
    )
  }
  requireCase(lost && reservationId !== undefined)
  await controller.assertOwnersDrained()
  const result = await mergeAuthenticatedBrc39NativeInactive(encrypted(controller, 4093), controller.password, {
    ...controller.options,
    source: { ...controller.options.source, reservationId }
  })
  await assertComplete(controller, result, expected)
}
