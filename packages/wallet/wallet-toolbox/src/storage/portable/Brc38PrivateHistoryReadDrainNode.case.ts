import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { readBrc38ImportJournal } from './Brc38ImportJournal'
import type { Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import type { Brc38StreamedSyncMapProjectionPolicy } from './Brc38StreamedSyncMapProjectionNode'
import { readBrc38SqlProjectedStructuredRange } from './Brc38SqlProjectedStructuredStaging'

/** Authored UNRUN. Requires the finite controller's actual packaged private
 * native owner in its authenticated structured receiver scope, before an
 * admitted request/sync-state page. DELETE-mode projection must succeed while
 * every readonly transaction has drained before each derived SQL write. The
 * controller supplies independently calculated mapped JSON, never output from
 * the projection under test. No process/pool is created by this fixture. */
export async function verifyPrivateHistoryReadDrain(
  store: KnexBrc38StagingStore,
  admission: Brc38ImportJournalAdmission,
  table: 'provenTxReqs' | 'syncStates',
  index: number,
  sourcePolicy: Brc38PrivateStructuredPolicy,
  projectionPolicy: Brc38StreamedSyncMapProjectionPolicy,
  expected: Uint8Array,
  expectedMissing: number
): Promise<void> {
  if (
    !(expected instanceof Uint8Array) ||
    expected.byteLength < 2 ||
    expected.byteLength > 65536 ||
    !Number.isSafeInteger(expectedMissing) ||
    expectedMissing < 0
  )
    throw new RangeError('Independent bounded history oracle required')
  const read = async <T>(work: (trx: import('knex').Knex.Transaction) => Promise<T>): Promise<T> =>
      await store.withPrivateNativeDatabase(true, async database => await database.transaction(work)),
    before = await read(async trx => await readBrc38ImportJournal(trx, admission)),
    prepared =
      table === 'provenTxReqs'
        ? await store.stagePrivateNotifyProjection(admission, index, before.nextRow, sourcePolicy, projectionPolicy)
        : await store.stagePrivateSyncMapProjection(admission, index, before.nextRow, sourcePolicy, projectionPolicy)
  if (prepared.unmappedIds !== expectedMissing || prepared.descriptor.bytes !== expected.byteLength)
    throw new Error('Actual private projection differs from the independent history fixture')
  await read(async trx => {
    if (JSON.stringify(await readBrc38ImportJournal(trx, admission)) !== JSON.stringify(before))
      throw new Error('History preparation advanced the operational import receipt')
    for (let offset = 0; offset < expected.byteLength;) {
      const length = Math.min(1024, expected.byteLength - offset),
        bytes = await readBrc38SqlProjectedStructuredRange(
          trx,
          table,
          index,
          prepared.descriptor.field,
          offset,
          length,
          prepared.descriptor,
          1024,
          () => store.assertPrivateNativeReadTransaction(trx)
        )
      try {
        for (let position = 0; position < length; position++)
          if (bytes[position] !== expected[offset + position])
            throw new Error('Actual private mapped history differs from independent canonical bytes')
      } finally {
        bytes.fill(0)
      }
      offset += length
    }
  })
}
