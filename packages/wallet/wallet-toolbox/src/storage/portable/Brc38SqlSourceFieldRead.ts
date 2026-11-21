import type { Knex } from 'knex'
import { readBrc38SqlPrefixSchemaVersion } from './Brc38SqlStructuredPrefixGuards'
import { readAllBrc38SqlBinaryFieldContent, countBrc38SqlBinaryFieldMetadata } from './Brc38SqlBinaryStaging'
import {
  readAllBrc38SqlStructuredFieldContent,
  countBrc38SqlStructuredFieldMetadata
} from './Brc38SqlStructuredStaging'
import {
  readAllBrc38SqlCanonicalStructuredFieldContent,
  countBrc38SqlCanonicalStructuredFieldMetadata
} from './Brc38SqlCanonicalStructuredStaging'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

import { readAllBrc38SqlTextFieldContent, countBrc38SqlTextFieldMetadata } from './Brc38SqlTextStaging'

interface Counts {
  readonly fields: number
  readonly chunks: number
}
/** Scalar metadata for ONE original drained read/write operation. These values
 * supply no source, schema, backend, semantic or authentication authority. */
export interface Brc38SqlSourceFieldCounts {
  readonly schemaVersion: number
  readonly binary?: Counts
  readonly structured?: Counts
  readonly canonical?: Counts
  readonly text?: Counts
}
function invalid(): never {
  throw new Error('Private source field family, immutable generation or current counts differs')
}
async function current(k: Knex): Promise<Readonly<Brc38SqlSourceFieldCounts>> {
  // Every family independently verifies its exact current definitions,
  // including empty tables and append-only prefix/source guards.
  return Object.freeze({
    schemaVersion: await readBrc38SqlPrefixSchemaVersion(k),
    binary: await countBrc38SqlBinaryFieldMetadata(k),
    structured: await countBrc38SqlStructuredFieldMetadata(k),
    canonical: await countBrc38SqlCanonicalStructuredFieldMetadata(k),
    text: await countBrc38SqlTextFieldMetadata(k)
  })
}
function same(a: Brc38SqlSourceFieldCounts, b: Brc38SqlSourceFieldCounts): boolean {
  const family = (left: Counts | undefined, right: Counts | undefined): boolean =>
    left === undefined
      ? right === undefined
      : right !== undefined && left.fields === right.fields && left.chunks === right.chunks
  return (
    a.schemaVersion === b.schemaVersion &&
    family(a.binary, b.binary) &&
    family(a.structured, b.structured) &&
    family(a.canonical, b.canonical) &&
    family(a.text, b.text)
  )
}
function selected(counts: Brc38SqlSourceFieldCounts, streamed: boolean, structured: boolean): void {
  if (
    (!streamed && ((counts.binary?.fields ?? 0) !== 0 || (counts.text?.fields ?? 0) !== 0)) ||
    (!structured && ((counts.structured?.fields ?? 0) !== 0 || (counts.canonical?.fields ?? 0) !== 0)) ||
    (counts.canonical !== undefined && counts.structured === undefined)
  )
    invalid()
}
/** Full independent physical chunk and whole-field hashing in bounded windows
 * under actual query_only=ON. The actual owning store drains this transaction
 * before opening its writer. Completed fields cannot be rewritten/deleted with
 * the current exact guards; any insertion changes these fresh counts, and a
 * guard drop/recreation changes native DDL generation. No payload or complete
 * field list is retained across transactions. Row semantics/counts/header and
 * original owner/profile/expiry are separate current checks in the store. */
export async function readBrc38SqlSourceFieldContent(
  trx: Knex.Transaction,
  maximumRows: number,
  maximumReadBytes: number,
  streamed: boolean,
  structured: boolean,
  active: () => void
): Promise<Readonly<Brc38SqlSourceFieldCounts>> {
  if (
    trx.isTransaction !== true ||
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > 1000000000 ||
    !Number.isSafeInteger(maximumReadBytes) ||
    (maximumReadBytes !== 0 && (maximumReadBytes < 128 || maximumReadBytes > 65536))
  )
    invalid()
  const mode = (await trx.raw('PRAGMA query_only')) as Array<{ query_only: number }>
  if (mode.length !== 1 || mode[0].query_only !== 1) invalid()
  active()
  const before = await current(trx)
  selected(before, streamed, structured)
  // Existing plain-row sources with no staged fields need no content window.
  // Zero never admits a field or enlarges the caller's original allowance.
  if (maximumReadBytes === 0) {
    if (
      (before.binary?.fields ?? 0) !== 0 ||
      (before.structured?.fields ?? 0) !== 0 ||
      (before.canonical?.fields ?? 0) !== 0 ||
      (before.text?.fields ?? 0) !== 0
    )
      throw new SnapshotResourceLimitError('Private source fields cannot fit the original content window')
    active()
    return before
  }
  if (streamed) {
    await readAllBrc38SqlBinaryFieldContent(trx, maximumRows, maximumReadBytes, active)
    await readAllBrc38SqlTextFieldContent(trx, maximumRows, maximumReadBytes, active)
  }
  if (structured) {
    await readAllBrc38SqlStructuredFieldContent(trx, maximumRows, maximumReadBytes, active)
    await readAllBrc38SqlCanonicalStructuredFieldContent(trx, maximumRows, maximumReadBytes, active)
  }
  const after = await current(trx)
  selected(after, streamed, structured)
  if (!same(before, after)) invalid()
  active()
  return after
}
/** Short fresh writer comparison after the original physical read has drained.
 * Expected counts are operation DATA, never a reusable content/source verdict.
 * Existing complete postimages are protected by exact current native guards;
 * new fields/chunks and removed/recreated guards refuse. No chunk/hash I/O. */
export async function compareBrc38SqlSourceFieldCounts(
  trx: Knex.Transaction,
  expected: Brc38SqlSourceFieldCounts,
  streamed: boolean,
  structured: boolean,
  active: () => void
): Promise<void> {
  if (trx.isTransaction !== true) invalid()
  active()
  const actual = await current(trx)
  selected(actual, streamed, structured)
  if (!same(actual, expected)) invalid()
  active()
}
