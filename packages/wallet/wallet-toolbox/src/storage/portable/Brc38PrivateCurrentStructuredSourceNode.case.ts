import { promiseFromSync } from '../../utility/promiseFromSync'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import {
  withBrc38PrivateCurrentStructuredSource,
  withBrc38PrivateCurrentCheckpointDelta,
  type Brc38PrivateCurrentStructuredPolicy
} from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38CheckpointSyncMapDelta } from './Brc38CheckpointSyncMap'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import type { Brc38StreamedStructured } from './Brc38StructuredJson'
import { stringifyBrc38StructuredJsonSpan } from './Brc38StructuredJson'

interface CurrentFieldFixture extends Pick<Brc38NativeTextRead, 'table' | 'field' | 'rowId'> {
  /** Independent original fixture string, never a generated production hash. */
  readonly expected: string
}
function requireCase(condition: boolean): asserts condition {
  if (!condition) throw new Error('Independent actual current structured source oracle differs')
}
/** Authored UNRUN. Called only by the complete finite native controller with
 * an actual private read transaction, current packed fields and owned scratch
 * parent. Five current fields are compared byte-for-byte, including arbitrary
 * cross-Unicode byte windows. This supplies no archive/merge/primary admission. */
export async function verifyPrivateCurrentStructuredSources(
  storage: StorageKnex,
  trx: Knex.Transaction,
  fixtures: readonly CurrentFieldFixture[],
  policy: Brc38PrivateCurrentStructuredPolicy
): Promise<void> {
  const coordinates = [
    'provenTxReqs.history',
    'provenTxReqs.notify',
    'syncStates.syncMap',
    'syncStates.errorLocal',
    'syncStates.errorOther'
  ]
  requireCase(
    fixtures.length === 5 &&
      new Set(fixtures.map(value => value.table + '.' + value.field)).size === 5 &&
      coordinates.every(value => fixtures.some(field => field.table + '.' + field.field === value))
  )
  for (const fixture of fixtures) {
    requireCase(typeof fixture.expected === 'string' && Buffer.byteLength(fixture.expected) <= 16777216)
    const expected = Buffer.from(fixture.expected),
      digest = createHash('sha256')
    let escaped: Readonly<Brc38StreamedStructured> | undefined
    await withBrc38PrivateCurrentStructuredSource(storage, trx, fixture, policy, async (source, descriptor) => {
      escaped = source
      requireCase(
        source.encoding === 'utf8' &&
          source.length === expected.length &&
          descriptor.bytes === expected.length &&
          descriptor.sha256 === createHash('sha256').update(expected).digest('hex')
      )
      for (let offset = 0; offset < expected.length; offset += 1021) {
        const length = Math.min(1021, expected.length - offset),
          bytes = await source.read(offset, length)
        try {
          requireCase(Buffer.from(bytes).equals(expected.subarray(offset, offset + length)))
          digest.update(bytes)
        } finally {
          bytes.fill(0)
        }
      }
      requireCase(digest.digest('hex') === descriptor.sha256)
      const index = await source.openIndex()
      await index.close()
      let duplicateIndexRefused = false
      try {
        await source.openIndex()
      } catch {
        duplicateIndexRefused = true
      }
      requireCase(duplicateIndexRefused)
    }).catch(cause => {
      // Duplicate-index refusal records an owned I/O failure; physical closure
      // must report it, rather than masking the error after callback recovery.
      requireCase(cause instanceof Error && cause.message.includes('already issued'))
    })
    requireCase(escaped !== undefined)
    let escapedRefused = false
    try {
      const bytes = await escaped.read(0, 1)
      bytes.fill(0)
    } catch {
      escapedRefused = true
    }
    requireCase(escapedRefused)
    const copied = new Proxy(trx, {})
    let copiedRefused = false,
      copiedWork = false
    try {
      await withBrc38PrivateCurrentStructuredSource(storage, copied, fixture, policy, () => {
        return promiseFromSync(() => {
          copiedWork = true
        })
      })
    } catch {
      copiedRefused = true
    }
    requireCase(copiedRefused && !copiedWork)
    expected.fill(0)
  }
}

/** Authored UNRUN. Actual retained native current map; expected output is an
 * independently supplied finite fixture oracle, not a producer's hash. No
 * row effects, checkpoint commit, primary activation or completed controller
 * qualification is inferred from this source/codec component case. */
export async function verifyPrivateCurrentCheckpointDelta(
  storage: StorageKnex,
  trx: Knex.Transaction,
  syncStateId: number,
  original: string,
  expected: string,
  delta: Brc38CheckpointSyncMapDelta,
  policy: Brc38PrivateCurrentStructuredPolicy
): Promise<void> {
  requireCase(Buffer.byteLength(original) <= 16777216 && Buffer.byteLength(expected) <= 16777216)
  const decodedExpected: unknown = JSON.parse(expected),
    parts: Uint8Array[] = []
  let escaped: AsyncIterable<Uint8Array> | undefined
  try {
    await withBrc38PrivateCurrentCheckpointDelta(storage, trx, syncStateId, policy, delta, async (chunks, prior) => {
      escaped = chunks
      requireCase(
        prior.bytes === Buffer.byteLength(original) &&
          prior.sha256 === createHash('sha256').update(original).digest('hex')
      )
      let bytes = 0
      for await (const part of chunks) {
        requireCase(part.byteLength >= 1 && part.byteLength <= (policy.maximumReadBytes ?? 65536))
        bytes += part.byteLength
        requireCase(bytes <= 16777216)
        parts.push(part)
      }
      const actual: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
      requireCase(JSON.stringify(canonical(actual)) === JSON.stringify(canonical(decodedExpected)))
    })
    requireCase(escaped !== undefined)
    let refused = false
    try {
      for await (const part of escaped) part.fill(0)
    } catch {
      refused = true
    }
    requireCase(refused)
    let earlyExitRefused = false
    try {
      await withBrc38PrivateCurrentCheckpointDelta(storage, trx, syncStateId, policy, delta, async chunks => {
        const iterator = chunks[Symbol.asyncIterator](),
          first = await iterator.next()
        if (!first.done) {
          try {
            first.value.fill(0)
          } finally {
            await iterator.return?.()
          }
        }
      })
    } catch (cause) {
      requireCase(cause instanceof Error && cause.message.includes('authenticated EOF'))
      earlyExitRefused = true
    }
    requireCase(earlyExitRefused)
  } finally {
    for (const part of parts) part.fill(0)
  }
}
/** Finite independent fixture comparison only; production maps remain streamed. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value).sort((a, b) => Number(a > b) - Number(a < b)))
      result[key] = canonical(Reflect.get(value, key))
    return result
  }
  return value
}

/** Authored UNRUN. Independent ordinary JSON.stringify oracle checks genuine
 * private legacy spelling through two complete passes on the same source.
 * Each pass needs two indexes; their drainage permits the next pass without
 * increasing the original aggregate temporary allowance. */
export async function verifyPrivateCurrentLegacySpelling(
  storage: StorageKnex,
  trx: Knex.Transaction,
  fixture: CurrentFieldFixture,
  selected: Brc38PrivateCurrentStructuredPolicy
): Promise<void> {
  requireCase(Buffer.byteLength(fixture.expected) <= 16777216 && selected.maximumTemporaryIndexBytes >= 2097152)
  const policy = { ...selected, maximumOpenIndexes: 2 as const },
    expected = JSON.stringify(JSON.parse(fixture.expected))
  await withBrc38PrivateCurrentStructuredSource(storage, trx, fixture, policy, async source => {
    for (let pass = 0; pass < 2; pass++) {
      const parts: Uint8Array[] = []
      let bytes = 0
      try {
        for await (const part of stringifyBrc38StructuredJsonSpan(
          source,
          { start: 0, end: source.length },
          {
            maximumInputBytes: policy.maximumStructuredBytes,
            maximumOutputBytes: policy.maximumCanonicalBytes,
            maximumChunkBytes: 64,
            maximumAllocationBytes: policy.maximumGrammarAllocationBytes,
            workingAllocation: policy.workingAllocation,
            signal: policy.signal
          }
        )) {
          bytes += part.length
          requireCase(part.length > 0 && part.length <= 64 && bytes <= 16777216)
          parts.push(part)
        }
        requireCase(Buffer.concat(parts).toString('utf8') === expected)
      } finally {
        for (const part of parts) part.fill(0)
      }
    }
  })
  let refused = false
  try {
    await withBrc38PrivateCurrentStructuredSource(storage, trx, fixture, policy, async source => {
      await source.openIndex()
      await source.openIndex()
      await source.openIndex()
    })
  } catch (cause) {
    requireCase(cause instanceof Error && cause.message.includes('allowance is already owned'))
    refused = true
  }
  requireCase(refused)
}
