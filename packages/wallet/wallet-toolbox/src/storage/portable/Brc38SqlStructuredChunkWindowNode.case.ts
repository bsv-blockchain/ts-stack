import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import {
  readBrc38SqlStructuredDescriptors,
  readBrc38SqlStructuredRange,
  finishBrc38SqlStructuredField
} from './Brc38SqlStructuredStaging'
import {
  readBrc38SqlCanonicalStructuredDescriptors,
  readBrc38SqlCanonicalStructuredRange,
  finishBrc38SqlCanonicalStructuredField
} from './Brc38SqlCanonicalStructuredStaging'
import {
  readBrc38SqlProjectedStructuredDescriptors,
  readBrc38SqlProjectedStructuredRange,
  verifyBrc38SqlProjectedStructuredCompleteField
} from './Brc38SqlProjectedStructuredStaging'

/** Authored UNRUN: a fresh packaged native controller must supply its genuine
 * currently retained actor and independently authored completed-field fixture.
 * This compares bytes/transfers, not authentication or complete semantics. */
export async function verifyNativeStructuredSqlWindowOracle(
  k: Knex.Transaction,
  family: 'raw' | 'canonical' | 'projected',
  coordinate: Readonly<{ table: Brc38StageTable; position: number; field: string }>,
  expected: Uint8Array,
  assertCurrent: () => void
): Promise<void> {
  if (
    !['raw', 'canonical', 'projected'].includes(family) ||
    !(expected instanceof Uint8Array) ||
    expected.byteLength < 2 ||
    expected.byteLength > 1048576
  )
    throw new RangeError('Independent native structured fixture required')
  const descriptors =
      family === 'raw'
        ? readBrc38SqlStructuredDescriptors
        : family === 'canonical'
          ? readBrc38SqlCanonicalStructuredDescriptors
          : readBrc38SqlProjectedStructuredDescriptors,
    read =
      family === 'raw'
        ? readBrc38SqlStructuredRange
        : family === 'canonical'
          ? readBrc38SqlCanonicalStructuredRange
          : readBrc38SqlProjectedStructuredRange,
    verify =
      family === 'raw'
        ? finishBrc38SqlStructuredField
        : family === 'canonical'
          ? finishBrc38SqlCanonicalStructuredField
          : verifyBrc38SqlProjectedStructuredCompleteField,
    actual = (await descriptors(k, coordinate.table, coordinate.position))[coordinate.field],
    oracle = createHash('sha256').update(expected).digest('hex')
  if (actual?.bytes !== expected.byteLength || actual.sha256 !== oracle)
    throw new Error('Independent native structured descriptor differs')
  for (const maximum of [1024, 4096]) {
    let transfers = 0
    const observe = (response: unknown): void => {
      for (const row of Array.isArray(response) ? response : [response]) {
        if (row === null || typeof row !== 'object' || !Object.hasOwn(row, 'payload')) continue
        const value = (row as { payload: unknown }).payload
        if (!(value instanceof Uint8Array) || value.byteLength > maximum)
          throw new Error('Native structured SQL transfer exceeds its window')
        transfers++
      }
    }
    k.on('query-response', observe)
    try {
      for (const offset of new Set([
        0,
        Math.min(17, expected.byteLength - 1),
        Math.max(0, expected.byteLength - 1030)
      ])) {
        assertCurrent()
        const length = Math.min(maximum, expected.byteLength - offset),
          bytes = await read(
            k,
            coordinate.table,
            coordinate.position,
            coordinate.field,
            offset,
            length,
            actual,
            maximum,
            assertCurrent
          )
        try {
          if (!Buffer.from(bytes).equals(Buffer.from(expected.subarray(offset, offset + length))))
            throw new Error('Independent native structured range bytes differ')
        } finally {
          bytes.fill(0)
        }
      }
      await verify(k, coordinate.table, coordinate.position, actual, assertCurrent, maximum)
      if (transfers === 0) throw new Error('Native structured window did not observe actual payload transfers')
      assertCurrent()
    } finally {
      k.removeListener('query-response', observe)
    }
  }
}
