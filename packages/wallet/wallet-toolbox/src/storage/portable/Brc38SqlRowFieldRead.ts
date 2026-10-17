import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import type { Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { readBrc38SqlBinaryDescriptors } from './Brc38SqlBinaryStaging'
import { readBrc38SqlStructuredDescriptors } from './Brc38SqlStructuredStaging'
import { visitBrc38SqlProvisionalStructuredChunkWindows } from './Brc38SqlStructuredChunkWindowNode'
import { readBrc38SqlPrefixSchemaVersion } from './Brc38SqlStructuredPrefixGuards'

import type { Brc38JsonTextField } from './Brc38JsonTextFields'
import { readBrc38SqlTextDescriptors } from './Brc38SqlTextStaging'

type Family = 'binary' | 'structured' | 'text'
interface FieldMetadata {
  readonly tableName: Brc38StageTable
  readonly position: number
  readonly field: string
  readonly encoding: string
  readonly maximumBytes: number
  readonly bytes: number
  readonly chunks: number
  readonly state: 'complete'
  readonly sha256: string
}
/** Exact immutable-prefix metadata DATA, retained only within one row operation.
 * This object cannot authorize source access, semantic admission or a writer. */
export interface Brc38SqlRowFieldMetadata {
  readonly table: Brc38StageTable
  readonly position: number
  readonly schemaVersion: number
  readonly binary: readonly Readonly<FieldMetadata>[]
  readonly structured: readonly Readonly<FieldMetadata>[]
  readonly text: readonly Readonly<FieldMetadata>[]
}
function invalid(): never {
  throw new Error('Private row field content or current metadata differs')
}
async function fields(
  k: Knex.Transaction,
  family: Family,
  table: Brc38StageTable,
  position: number,
  expected: Readonly<Record<string, Brc38JsonStreamedField | Brc38JsonStructuredField | Brc38JsonTextField>>,
  check: () => void
): Promise<readonly Readonly<FieldMetadata>[]> {
  check()
  // These independently verify exact physical schema, immutable prefix guards,
  // complete metadata and bounded field identities even for an empty family.
  const descriptors =
      family === 'binary'
        ? await readBrc38SqlBinaryDescriptors(k, table, position)
        : family === 'structured'
          ? await readBrc38SqlStructuredDescriptors(k, table, position)
          : await readBrc38SqlTextDescriptors(k, table, position),
    names = Object.keys(expected).sort((a, b) => Number(a > b) - Number(a < b))
  if (names.length > (family === 'text' ? 7 : 3) || names.length !== Object.keys(descriptors).length) invalid()
  const result: Readonly<FieldMetadata>[] = []
  for (const field of names) {
    check()
    const value = expected[field],
      actual = descriptors[field]
    if (
      actual === undefined ||
      value.field !== field ||
      value.encoding !== actual.encoding ||
      value.bytes !== actual.bytes ||
      value.sha256 !== actual.sha256
    )
      invalid()
    const rows = (await k(`private_${family}_fields`)
      .where({ tableName: table, position, field })
      .select('tableName', 'position', 'field', 'encoding', 'maximumBytes', 'bytes', 'chunks', 'state', 'sha256')
      .limit(2)) as FieldMetadata[]
    if (rows.length !== 1) invalid()
    const row = rows[0]
    if (
      row.tableName !== table ||
      row.position !== position ||
      row.field !== field ||
      row.state !== 'complete' ||
      row.encoding !== actual.encoding ||
      row.bytes !== actual.bytes ||
      row.sha256 !== actual.sha256 ||
      !Number.isSafeInteger(row.maximumBytes) ||
      row.maximumBytes < row.bytes ||
      !Number.isSafeInteger(row.chunks) ||
      row.chunks < 0 ||
      row.chunks > row.bytes ||
      (row.chunks === 0) !== (row.bytes === 0)
    )
      invalid()
    result.push(Object.freeze({ ...row }))
  }
  check()
  return Object.freeze(result)
}
const descriptors = (
  values: readonly Readonly<FieldMetadata>[]
): Readonly<Record<string, Brc38JsonStreamedField | Brc38JsonStructuredField | Brc38JsonTextField>> =>
  Object.freeze(
    Object.fromEntries(
      values.map(value => [
        value.field,
        Object.freeze({ field: value.field, encoding: value.encoding, bytes: value.bytes, sha256: value.sha256 })
      ])
    )
  ) as Readonly<Record<string, Brc38JsonStreamedField | Brc38JsonStructuredField | Brc38JsonTextField>>

/** Actual bounded complete hashing in an original query-only staging view.
 * The caller drains this view before its writer. Metadata equality in that
 * writer is useful only alongside freshly verified immutable-prefix guards;
 * this function stores no source, backend, authority or semantic verdict. */
export async function readBrc38SqlRowFieldContent(
  k: Knex.Transaction,
  table: Brc38StageTable,
  position: number,
  binary: Readonly<Record<string, Brc38JsonStreamedField>>,
  structured: Readonly<Record<string, Brc38JsonStructuredField>>,
  maximumReadBytes: number,
  check: () => void,
  text: Readonly<Record<string, Brc38JsonTextField>> = {}
): Promise<Readonly<Brc38SqlRowFieldMetadata>> {
  check()
  if (
    k.isTransaction !== true ||
    !Number.isSafeInteger(maximumReadBytes) ||
    maximumReadBytes < 1 ||
    maximumReadBytes > 65536
  )
    invalid()
  const mode = (await k.raw('PRAGMA query_only')) as Array<{ query_only: number }>
  if (mode.length !== 1 || mode[0].query_only !== 1) invalid()
  const metadata = Object.freeze({
    table,
    position,
    schemaVersion: await readBrc38SqlPrefixSchemaVersion(k),
    binary: await fields(k, 'binary', table, position, binary, check),
    structured: await fields(k, 'structured', table, position, structured, check),
    text: await fields(k, 'text', table, position, text, check)
  })
  for (const family of ['binary', 'structured', 'text'] as const)
    for (const value of metadata[family]) {
      check()
      const coordinate = { tableName: table, position, field: value.field },
        chunks = `private_${family}_chunks` as const,
        aggregate = (await k(chunks).where(coordinate).count({ count: '*' }).sum({ bytes: 'bytes' }).first()) as
          { count: number; bytes: number | null } | undefined
      if (aggregate === undefined || aggregate.count !== value.chunks || (aggregate.bytes ?? 0) !== value.bytes)
        invalid()
      const hash = createHash('sha256'),
        decoder = family === 'text' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined
      let offset = 0
      for (let index = 0; index < value.chunks; index++) {
        check()
        const chunk = await visitBrc38SqlProvisionalStructuredChunkWindows(
          k,
          chunks,
          { ...coordinate, offset },
          maximumReadBytes,
          check,
          bytes => {
            hash.update(bytes)
            decoder?.decode(bytes, { stream: true })
          }
        )
        if (chunk.bytes > value.bytes - offset) invalid()
        offset += chunk.bytes
      }
      decoder?.decode()
      if (
        offset !== value.bytes ||
        hash.digest('hex') !== value.sha256 ||
        (await k(chunks).where(coordinate).where('offset', '>=', offset).first('offset')) !== undefined
      )
        invalid()
    }
  await compareBrc38SqlRowFieldMetadata(k, metadata, check)
  check()
  return metadata
}
/** Fresh exact definitions and metadata in the actual final transaction.
 * This compares DATA from the just-drained source operation. It cannot replace
 * current owner/profile/semantic/row/key/quota/checkpoint checks by the caller. */
export async function compareBrc38SqlRowFieldMetadata(
  k: Knex.Transaction,
  selected: Readonly<Brc38SqlRowFieldMetadata>,
  check: () => void
): Promise<void> {
  check()
  if (k.isTransaction !== true) invalid()
  if ((await readBrc38SqlPrefixSchemaVersion(k)) !== selected.schemaVersion) invalid()
  for (const family of ['binary', 'structured', 'text'] as const) {
    const actual = await fields(k, family, selected.table, selected.position, descriptors(selected[family]), check)
    if (JSON.stringify(actual) !== JSON.stringify(selected[family])) invalid()
  }
  check()
}
