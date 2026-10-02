import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  MAX_SNAPSHOT_JOURNAL_REVISION,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'

export const SNAPSHOT_JOURNAL_SQLITE_CLOCK = 'snapshot_journal_clock'

export const SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL = `CREATE TABLE snapshot_journal_clock (
id INTEGER NOT NULL PRIMARY KEY CHECK(id=1),
revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
ceiling INTEGER NOT NULL CHECK(typeof(ceiling)='integer' AND ceiling>=revision),
enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
reason TEXT CHECK((enabled=1 AND reason IS NULL) OR (enabled=0 AND reason IS NOT NULL AND reason IN ('capacity-exhausted','revision-exhausted','key-out-of-range')))
)`

/** Advance only within the reserved event window; the source write may still commit. */
export const SNAPSHOT_JOURNAL_SQLITE_ADVANCE = `UPDATE snapshot_journal_clock SET
revision=CASE WHEN revision<ceiling THEN revision+1 ELSE revision END,
enabled=CASE WHEN revision>=ceiling THEN 0 ELSE enabled END,
reason=CASE WHEN revision>=ceiling THEN CASE WHEN revision=${MAX_SNAPSHOT_JOURNAL_REVISION} THEN 'revision-exhausted' ELSE 'capacity-exhausted' END ELSE reason END
WHERE id=1 AND enabled=1; `

/** Guard every metadata write after advancing: the current event may invalidate the epoch. */
export const SNAPSHOT_JOURNAL_SQLITE_WRITABLE = '(SELECT enabled FROM snapshot_journal_clock WHERE id=1)=1'
export const SNAPSHOT_JOURNAL_SQLITE_REVISION = '(SELECT revision FROM snapshot_journal_clock WHERE id=1)'

/** New owned installation only. Recovery and epoch replacement belong to the migration. */
export async function installSnapshotJournalSqliteClock(k: Knex, ceiling: SnapshotJournalRevision): Promise<void> {
  if (k.client.config.client !== 'sqlite3' && k.client.config.client !== 'better-sqlite3') {
    throw new WERR_INVALID_OPERATION('Snapshot journal clock requires SQLite')
  }
  if (snapshotJournalRevision(ceiling) === '0') throw new WERR_INVALID_OPERATION('Empty snapshot journal event window')
  await k.transaction(async transaction => {
    await transaction.raw(SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL)
    await transaction(SNAPSHOT_JOURNAL_SQLITE_CLOCK).insert({
      id: 1,
      revision: 0,
      ceiling,
      enabled: 1,
      reason: null
    })
  })
}
