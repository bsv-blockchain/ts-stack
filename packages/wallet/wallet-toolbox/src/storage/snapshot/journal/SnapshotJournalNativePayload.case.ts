import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import {
  readSnapshotJournalPayloadRow,
  writeSnapshotJournalPayloadRow,
  snapshotJournalPayloadLength,
  type SnapshotJournalPayloadTable
} from './SnapshotJournalNativePayload'
import { verifySnapshotJournalDestinationSchema } from './SnapshotJournalDestinationSchema'
import { SNAPSHOT_JOURNAL_SHARED_QUOTA, verifySnapshotJournalSharedQuota } from './SnapshotJournalSharedQuota'
import { withBrc38NativeLocalPackedWalletMutation } from '../../portable/Brc38NativeLocalPackedWalletNode'
import { assertSnapshotJournalOrdinaryDataDeletion } from './SnapshotJournalNativeDestinationSchema'

interface ActualController {
  withRead<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
  withWriter<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent actual native journal payload case differs')
}
async function quota(k: Knex.Transaction): Promise<{ bytes: number; rows: number }> {
  await verifySnapshotJournalSharedQuota(k)
  const values = (await k(SNAPSHOT_JOURNAL_SHARED_QUOTA).where({ id: 0 }).select('bytes', 'rows').limit(2)) as Array<{
    bytes: number
    rows: number
  }>
  requireCase(values.length === 1)
  return values[0]
}
/** UNRUN. Real native private candidate with two already copied, independently
 * authored valid frame fixtures. Same-sized replacement isolates payload charge
 * from scalar SQL encoding sizes. This is a storage/rollback oracle, not source
 * receipt admission, semantic promotion, complete cutover or qualification. */
export async function verifySnapshotJournalNativePayloads(
  controller: ActualController,
  fixtures: readonly Readonly<{
    table: SnapshotJournalPayloadTable
    key: Record<string, unknown>
    original: Uint8Array
    replacement: Uint8Array
  }>[]
): Promise<void> {
  requireCase(fixtures.length === 2 && new Set(fixtures.map(value => value.table)).size === 2)
  for (const fixture of fixtures) {
    controller.check()
    requireCase(
      fixture.original instanceof Uint8Array &&
        fixture.replacement instanceof Uint8Array &&
        fixture.original.byteLength >= 4 &&
        fixture.original.byteLength <= 131072 &&
        fixture.replacement.byteLength === fixture.original.byteLength &&
        fixture.original.some((byte, at) => byte !== fixture.replacement[at])
    )
    const before = await controller.withRead(async trx => {
      await verifySnapshotJournalDestinationSchema(trx)
      const values = await trx(fixture.table)
        .where(fixture.key)
        .select(
          (await snapshotJournalPayloadLength(trx, fixture.table)).expression,
          trx.raw('typeof(payload) AS kind,length(payload) AS marker')
        )
        .limit(2)
      requireCase(
        values.length === 1 &&
          values[0].actualBytes === fixture.original.byteLength &&
          values[0].kind === 'blob' &&
          values[0].marker === 0
      )
      const bytes = await readSnapshotJournalPayloadRow(trx, fixture.table, fixture.key, fixture.original.byteLength)
      try {
        requireCase(bytes.every((byte, at) => byte === fixture.original[at]))
      } finally {
        bytes.fill(0)
      }
      return await quota(trx)
    })
    const failure = new Error('independent caught outer payload mutation failure')
    await controller.withWriter(async trx => {
      let caught: unknown
      try {
        await withBrc38NativeLocalPackedWalletMutation(trx, async (database, packed) => {
          requireCase(packed)
          await writeSnapshotJournalPayloadRow(
            database,
            fixture.table,
            fixture.key,
            {
              bytes: fixture.replacement.byteLength,
              digest: createHash('sha256').update(fixture.replacement).digest('hex')
            },
            fixture.replacement,
            {}
          )
          requireCase(JSON.stringify(await quota(trx)) === JSON.stringify(before))
          throw failure
        })
      } catch (cause) {
        caught = cause
      }
      requireCase(caught === failure && JSON.stringify(await quota(trx)) === JSON.stringify(before))
    })
    await controller.withRead(async trx => {
      const bytes = await readSnapshotJournalPayloadRow(trx, fixture.table, fixture.key, fixture.original.byteLength)
      try {
        requireCase(bytes.every((byte, at) => byte === fixture.original[at]))
      } finally {
        bytes.fill(0)
      }
      await verifySnapshotJournalDestinationSchema(trx)
    })
    await controller.withWriter(async trx => {
      await writeSnapshotJournalPayloadRow(
        trx,
        fixture.table,
        fixture.key,
        {
          bytes: fixture.replacement.byteLength,
          digest: createHash('sha256').update(fixture.replacement).digest('hex')
        },
        fixture.replacement,
        {}
      )
      requireCase(JSON.stringify(await quota(trx)) === JSON.stringify(before))
    })
    await controller.withRead(async trx => {
      const bytes = await readSnapshotJournalPayloadRow(trx, fixture.table, fixture.key, fixture.replacement.byteLength)
      try {
        requireCase(bytes.every((byte, at) => byte === fixture.replacement[at]))
      } finally {
        bytes.fill(0)
      }
      let refused = false
      try {
        await assertSnapshotJournalOrdinaryDataDeletion(trx)
      } catch {
        refused = true
      }
      requireCase(refused)
      await verifySnapshotJournalDestinationSchema(trx)
    })
  }
  controller.check()
}
