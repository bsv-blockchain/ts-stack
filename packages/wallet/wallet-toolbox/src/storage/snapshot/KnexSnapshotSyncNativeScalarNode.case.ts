import type { StorageKnex } from '../StorageKnex'
import { KnexSnapshotSyncDestination, type KnexSnapshotSyncFieldRead } from './KnexSnapshotSyncDestination'
import type { SnapshotSyncCheckpoint } from './SnapshotSync'
import type { WalletReadSnapshot } from './WalletReadSnapshot'
import type { TableOutputBasket } from '../schema/tables'

/** Authored UNRUN. The serial native controller supplies actual source/target
 * factories, a current outputBaskets session, independent expected merge rows
 * and completed predecessor admission. This component case grants no runtime,
 * source, all-table fairness, activation or production qualification. */
export async function verifyNativeScalarFieldSession(
  fixture: Readonly<{
    storage: StorageKnex
    source: WalletReadSnapshot
    checkpoint: SnapshotSyncCheckpoint
    expectedBaskets: readonly Readonly<TableOutputBasket>[]
  }>
): Promise<void> {
  const { storage, source, checkpoint, expectedBaskets } = fixture,
    destination = new KnexSnapshotSyncDestination(storage, async () => {
      throw new Error('Scalar field component performed proof I/O')
    })
  if (
    checkpoint.tableIndex !== 1 ||
    source.fieldReader === undefined ||
    expectedBaskets.length < 1 ||
    expectedBaskets.length > 2
  )
    throw new RangeError('Actual bounded native basket session required')
  const page = await source.fieldReader.readMetadataPage('outputBaskets', checkpoint.cursor, {
    maxRows: 2,
    maxBytes: 32768
  })
  if (!page.done || page.rows.length !== expectedBaskets.length)
    throw new Error('Independent scalar fixture cardinality differs')
  let escaped: Readonly<KnexSnapshotSyncFieldRead> | undefined
  await destination.inspectNativeFieldSession(checkpoint, undefined, async read => {
    escaped = read
    await read.loadFieldMappings(
      'outputBaskets',
      page.rows.map(row => row.fields)
    )
  })
  let refused = false
  try {
    await escaped!.loadFieldMappings(
      'outputBaskets',
      page.rows.map(row => row.fields)
    )
  } catch {
    refused = true
  }
  if (!refused) throw new Error('Native scalar read facade survived its actual lease drainage')
  const prepared = await destination.prepareNativeScalarFields(checkpoint, page, source)
  try {
    // Mutating the caller's former DATA must not mutate the original captured
    // page, entity contents or next ACK. No source actor is manufactured here.
    Reflect.set(page.rows[0].fields, 'name', 'caller-mutated-after-prepare')
    Reflect.set(page, 'done', false)
    Reflect.set(page, 'payloadBytes', 0)
    const commit = await prepared.apply()
    if (
      commit.checkpoint.sequence !== checkpoint.sequence + 1 ||
      commit.checkpoint.tableIndex !== 2 ||
      commit.checkpoint.cursor !== undefined
    )
      throw new Error('Native scalar checkpoint did not advance the original page atomically')
    const actual = await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey)
    if (JSON.stringify(actual) !== JSON.stringify(commit.checkpoint))
      throw new Error('Native scalar durable ACK differs')
    for (const expected of expectedBaskets) {
      const rows = await storage.findOutputBaskets({ partial: { userId: expected.userId, name: expected.name } })
      if (
        rows.length !== 1 ||
        JSON.stringify(Object.keys(rows[0]).sort()) !== JSON.stringify(Object.keys(expected).sort())
      )
        throw new Error('Native scalar merge differs from the independent original-policy oracle')
      for (const name of Object.keys(expected) as Array<keyof TableOutputBasket>) {
        const actual = rows[0][name],
          value = expected[name]
        if (
          value instanceof Date ? !(actual instanceof Date) || actual.getTime() !== value.getTime() : actual !== value
        )
          throw new Error('Native scalar merge differs from the independent original-policy oracle')
      }
    }
    refused = false
    try {
      await prepared.apply()
    } catch {
      refused = true
    }
    if (!refused) throw new Error('Native scalar one-use page applied twice')
  } finally {
    await prepared.close()
  }
}
