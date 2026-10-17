import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { Brc39RecoveryAuthenticationNode } from './Brc39RecoveryAuthenticationNode'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38WorkingAllocation, brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { brc38StageTables, type Brc38StageTable } from './Brc38SemanticStage'
import { readBrc38SqlSourceFieldContent } from './Brc38SqlSourceFieldRead'
import { readBrc38SqlBinaryDescriptors, readBrc38SqlBinaryWindow } from './Brc38SqlBinaryStaging'
import { readBrc38SqlTextDescriptors, readBrc38SqlTextRange } from './Brc38SqlTextStaging'
import { readBrc38SqlStructuredDescriptors, readBrc38SqlStructuredRange } from './Brc38SqlStructuredStaging'
import {
  readBrc38SqlCanonicalStructuredDescriptors,
  readBrc38SqlCanonicalStructuredRange
} from './Brc38SqlCanonicalStructuredStaging'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'

const issuer = Object.freeze({}),
  actual = new WeakSet<Brc39RecoveryIncomingComparisonNode>()
function invalid(): never {
  throw new Error('Recovery copied incoming source differs from its fresh full BRC39 authentication')
}
function equal(left: Uint8Array, right: Uint8Array): void {
  if (left.byteLength !== right.byteLength || !left.every((value, at) => value === right[at])) invalid()
}
/** A scoped full incoming comparison, never a cached verdict or activation
 * grant. Both actual kernels remain frozen, both outer owners stay retained,
 * and every read transaction drains before the consumer can inspect local
 * reconstruction or the independent permanent target. */
export class Brc39RecoveryIncomingComparisonNode {
  #live = true
  private constructor(
    token: object,
    readonly source: Brc39RecoveryAuthenticationNode,
    readonly candidate: KnexBrc38StagingStore
  ) {
    if (token !== issuer) invalid()
    actual.add(this)
    Object.freeze(this)
  }
  assertRetained(): void {
    if (
      !actual.has(this) ||
      !this.#live ||
      !this.candidate.recoveryComparisonOnly ||
      this.candidate.binding?.digest !== this.source.original.digest
    )
      invalid()
    Brc39RecoveryAuthenticationNode.prototype.assertRetained.call(this.source)
    this.candidate.assertPrivateNativeDestination(this.candidate.knex)
  }
  static async with<T>(
    source: Brc39RecoveryAuthenticationNode,
    candidate: KnexBrc38StagingStore,
    selected: Readonly<{ workingAllocation: Brc38WorkingAllocation; maximumReadBytes: number; signal?: AbortSignal }>,
    work: (comparison: Brc39RecoveryIncomingComparisonNode) => Promise<T>
  ): Promise<T> {
    Brc39RecoveryAuthenticationNode.prototype.assertRetained.call(source)
    const working = brc38WorkingAllocation(selected.workingAllocation),
      width = selected.maximumReadBytes,
      signal = selected.signal
    if (
      working === undefined ||
      working.maximum > candidate.limits.maximumRowAllocationBytes ||
      !candidate.recoveryComparisonOnly ||
      candidate.binding?.digest !== source.original.digest ||
      !Number.isSafeInteger(width) ||
      width < 128 ||
      width > 16384 ||
      typeof work !== 'function'
    )
      invalid()
    candidate.assertRecoverySharedWorking(working)
    const comparison = new Brc39RecoveryIncomingComparisonNode(issuer, source, candidate),
      charge = working.claim(1048576 + 128 * width),
      check = (): void => {
        signal?.throwIfAborted()
        comparison.assertRetained()
      }
    try {
      return await source.withSource(async fresh => {
        await candidate.withAuthenticatedPrivateStructuredDestination(async () => {
          await fresh.withPrivateNativeDatabase(
            true,
            async freshDb =>
              await freshDb.transaction(
                async incoming =>
                  await candidate.withPrivateNativeDatabase(
                    true,
                    async copyDb =>
                      await copyDb.transaction(async copied => {
                        const current = (): void => {
                          check()
                          fresh.assertPrivateNativeReadTransaction(incoming)
                          candidate.assertPrivateNativeReadTransaction(copied)
                        }
                        current()
                        await verifyBrc38AuthenticatedSourceSeal(incoming)
                        await verifyBrc38AuthenticatedSourceSeal(copied)
                        const original = await readBrc38SqlSourceFieldContent(
                            incoming,
                            candidate.limits.maximumRows,
                            width,
                            true,
                            true,
                            current
                          ),
                          saved = await readBrc38SqlSourceFieldContent(
                            copied,
                            candidate.limits.maximumRows,
                            width,
                            true,
                            true,
                            current
                          )
                        // Chunk layout is transport DATA and may differ on complete replay.
                        // Every chunk/hash has already been independently checked. Field
                        // counts must equal the coordinates actually compared below.
                        const seen = { binary: 0, text: 0, structured: 0, canonical: 0 }
                        const scalar = async (
                          table: string,
                          column: string,
                          where: Readonly<Record<string, unknown>>,
                          maximum: number
                        ): Promise<void> => {
                          const extent = async (k: Knex.Transaction): Promise<number> => {
                              const rows = (await k(table)
                                .where(where)
                                .select(k.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [column, column]))
                                .limit(2)) as Array<{ kind: string; bytes: number }>
                              if (
                                rows.length !== 1 ||
                                rows[0].kind !== 'text' ||
                                !Number.isSafeInteger(rows[0].bytes) ||
                                rows[0].bytes < 0 ||
                                rows[0].bytes > maximum
                              )
                                invalid()
                              return rows[0].bytes
                            },
                            bytes = await extent(incoming)
                          if ((await extent(copied)) !== bytes) invalid()
                          for (let offset = 0; offset < bytes; offset += width) {
                            current()
                            const length = Math.min(width, bytes - offset),
                              values: Uint8Array[] = []
                            try {
                              for (const k of [incoming, copied]) {
                                const rows = (await k(table)
                                  .where(where)
                                  .select(
                                    k.raw('substr(CAST(?? AS BLOB),?,?) AS payload', [column, offset + 1, length])
                                  )
                                  .limit(2)) as Array<{ payload: Uint8Array }>
                                if (
                                  rows.length !== 1 ||
                                  !(rows[0].payload instanceof Uint8Array) ||
                                  rows[0].payload.length !== length
                                )
                                  invalid()
                                values.push(rows[0].payload)
                              }
                              equal(values[0], values[1])
                              current()
                            } finally {
                              for (const value of values) value.fill(0)
                            }
                          }
                        }
                        await scalar('metadata', 'header', { slot: 1 }, candidate.limits.maximumRowBytes)
                        let total = 0
                        for (const table of brc38StageTables) {
                          current()
                          const count = async (k: Knex.Transaction): Promise<number> => {
                              const rows = (await k('table_counts')
                                  .where({ tableName: table })
                                  .select('rows')
                                  .limit(2)) as Array<{ rows: number }>,
                                actualRows = (await k('rows')
                                  .where({ tableName: table })
                                  .count({ count: '*' })
                                  .first()) as { count: number } | undefined
                              if (
                                rows.length !== 1 ||
                                !Number.isSafeInteger(rows[0].rows) ||
                                rows[0].rows < 0 ||
                                rows[0].rows > candidate.limits.maximumRows ||
                                actualRows?.count !== rows[0].rows
                              )
                                invalid()
                              return rows[0].rows
                            },
                            count_ = await count(incoming)
                          if ((await count(copied)) !== count_ || count_ > candidate.limits.maximumRows - total)
                            invalid()
                          total += count_
                          for (let position = 0; position < count_; position++) {
                            const coordinate = { tableName: table, position }
                            await scalar('rows', 'payload', coordinate, candidate.limits.maximumRowBytes)
                            await scalar('rows', 'recordDigest', coordinate, 64)
                            const binaries = await readBrc38SqlBinaryDescriptors(incoming, table, position),
                              copyBinaries = await readBrc38SqlBinaryDescriptors(copied, table, position)
                            if (JSON.stringify(binaries) !== JSON.stringify(copyBinaries)) invalid()
                            for (const descriptor of Object.values(binaries)) {
                              seen.binary++
                              const hashes = [createHash('sha256'), createHash('sha256')]
                              for (let offset = 0; offset < descriptor.bytes;) {
                                current()
                                let left: Awaited<ReturnType<typeof readBrc38SqlBinaryWindow>>, right: typeof left
                                try {
                                  left = await readBrc38SqlBinaryWindow(
                                    incoming,
                                    table,
                                    position,
                                    descriptor.field,
                                    offset,
                                    width
                                  )
                                  right = await readBrc38SqlBinaryWindow(
                                    copied,
                                    table,
                                    position,
                                    descriptor.field,
                                    offset,
                                    width
                                  )
                                  if (
                                    left === undefined ||
                                    right === undefined ||
                                    left.offset !== offset ||
                                    right.offset !== offset
                                  )
                                    invalid()
                                  const amount = Math.min(left.bytes.length, right.bytes.length)
                                  if (amount < 1 || amount > descriptor.bytes - offset) invalid()
                                  equal(left.bytes.subarray(0, amount), right.bytes.subarray(0, amount))
                                  hashes[0].update(left.bytes.subarray(0, amount))
                                  hashes[1].update(right.bytes.subarray(0, amount))
                                  offset += amount
                                } finally {
                                  left?.bytes.fill(0)
                                  right?.bytes.fill(0)
                                }
                              }
                              if (hashes.some(hash => hash.digest('hex') !== descriptor.sha256)) invalid()
                            }
                            await compareTextFamily('text', incoming, copied, table, position)
                            await compareTextFamily('structured', incoming, copied, table, position)
                            await compareTextFamily('canonical', incoming, copied, table, position)
                          }
                        }
                        async function compareTextFamily(
                          family: 'text' | 'structured' | 'canonical',
                          a: Knex.Transaction,
                          b: Knex.Transaction,
                          table: Brc38StageTable,
                          position: number
                        ): Promise<void> {
                          const descriptors =
                              family === 'text'
                                ? await readBrc38SqlTextDescriptors(a, table, position)
                                : family === 'structured'
                                  ? await readBrc38SqlStructuredDescriptors(a, table, position)
                                  : await readBrc38SqlCanonicalStructuredDescriptors(a, table, position),
                            other =
                              family === 'text'
                                ? await readBrc38SqlTextDescriptors(b, table, position)
                                : family === 'structured'
                                  ? await readBrc38SqlStructuredDescriptors(b, table, position)
                                  : await readBrc38SqlCanonicalStructuredDescriptors(b, table, position)
                          if (JSON.stringify(descriptors) !== JSON.stringify(other)) invalid()
                          for (const descriptor of Object.values(descriptors)) {
                            seen[family]++
                            const hashes = [createHash('sha256'), createHash('sha256')]
                            for (let offset = 0; offset < descriptor.bytes; offset += width) {
                              current()
                              const length = Math.min(width, descriptor.bytes - offset),
                                values: Uint8Array[] = []
                              try {
                                for (const k of [a, b]) {
                                  const value =
                                    family === 'text'
                                      ? await readBrc38SqlTextRange(
                                          k,
                                          table,
                                          position,
                                          descriptor.field,
                                          offset,
                                          length,
                                          { ...descriptor, encoding: 'utf8' },
                                          width,
                                          current
                                        )
                                      : family === 'structured'
                                        ? await readBrc38SqlStructuredRange(
                                            k,
                                            table,
                                            position,
                                            descriptor.field,
                                            offset,
                                            length,
                                            { ...descriptor, encoding: 'utf8-json' },
                                            width,
                                            current
                                          )
                                        : await readBrc38SqlCanonicalStructuredRange(
                                            k,
                                            table,
                                            position,
                                            descriptor.field,
                                            offset,
                                            length,
                                            { ...descriptor, encoding: 'utf8-json' },
                                            width,
                                            current
                                          )
                                  values.push(value)
                                }
                                equal(values[0], values[1])
                                hashes[0].update(values[0])
                                hashes[1].update(values[1])
                              } finally {
                                for (const value of values) value.fill(0)
                              }
                            }
                            if (hashes.some(hash => hash.digest('hex') !== descriptor.sha256)) invalid()
                          }
                        }
                        for (const family of ['binary', 'text', 'structured', 'canonical'] as const)
                          if (
                            (original[family]?.fields ?? 0) !== seen[family] ||
                            (saved[family]?.fields ?? 0) !== seen[family]
                          )
                            invalid()
                        // Exact unique/membership sets prevent a copied source from changing
                        // semantic relationship keys while preserving payloads and digests.
                        for (const table of ['unique_keys', 'memberships']) {
                          let after: Readonly<{ namespace: string; key: string }> | undefined,
                            keys = 0
                          for (;;) {
                            current()
                            const next = async (
                                k: Knex.Transaction
                              ): Promise<Array<{ namespace: string; key: string }>> => {
                                const q = k(table)
                                  .select('namespace', 'key')
                                  .whereRaw(
                                    "typeof(namespace)='text' AND typeof(key)='text' AND length(CAST(namespace AS BLOB))<=256 AND length(CAST(key AS BLOB))<=4096"
                                  )
                                  .orderBy('namespace')
                                  .orderBy('key')
                                  .limit(1)
                                if (after !== undefined)
                                  q.whereRaw('(namespace,key)>(?,?)', [after.namespace, after.key])
                                return (await q) as Array<{ namespace: string; key: string }>
                              },
                              a = await next(incoming),
                              b = await next(copied)
                            if (JSON.stringify(a) !== JSON.stringify(b)) invalid()
                            if (a.length === 0) break
                            if (++keys > 32 * candidate.limits.maximumRows) invalid()
                            after = Object.freeze({ ...a[0] })
                          }
                          for (const k of [incoming, copied]) {
                            const count = (await k(table).count({ count: '*' }).first()) as
                              { count: number } | undefined
                            if (count?.count !== keys) invalid()
                          }
                        }
                        current()
                      })
                  )
              )
          )
        })
        // Both actual READ transactions have drained. Retain the frozen
        // owners and actual authentication scopes through final reconstruction.
        check()
        await fresh.requirePrivateNativeComparison()
        await candidate.requirePrivateNativeComparison()
        const value = await work(comparison)
        check()
        await fresh.requirePrivateNativeComparison()
        await candidate.requirePrivateNativeComparison()
        return value
      })
    } finally {
      comparison.#live = false
      charge.close()
    }
  }
}
