import type { Knex } from 'knex'
import { runInSeries } from '../../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  MAX_SNAPSHOT_JOURNAL_REVISION,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'

export const SNAPSHOT_JOURNAL_MYSQL_CLOCK_DDL = [
  'CREATE TABLE snapshot_journal_clock(id INTEGER NOT NULL PRIMARY KEY,ceiling BIGINT UNSIGNED NOT NULL,CHECK(id=1)) ENGINE=InnoDB',
  'CREATE TABLE snapshot_journal_events(revision BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB',
  "CREATE TABLE snapshot_journal_invalid(id INTEGER NOT NULL PRIMARY KEY,reason VARCHAR(32) NOT NULL,CHECK(id=1),CHECK(reason IN ('capacity-exhausted','revision-exhausted','key-out-of-range'))) ENGINE=InnoDB"
]

export const SNAPSHOT_JOURNAL_MYSQL_CLOCK_VARIABLES = `DECLARE journalCeiling BIGINT UNSIGNED;
DECLARE journalRevision BIGINT UNSIGNED;
DECLARE journalEnabled BOOLEAN; `

/** Shared barrier; invalidation uses another row. Unexpected native errors roll back the source transaction. */
export const SNAPSHOT_JOURNAL_MYSQL_ADVANCE = `SELECT ceiling INTO journalCeiling FROM snapshot_journal_clock WHERE id=1 FOR SHARE;
SELECT NOT EXISTS(SELECT 1 FROM snapshot_journal_invalid WHERE id=1) INTO journalEnabled;
IF journalEnabled THEN
  INSERT INTO snapshot_journal_events() VALUES();
  SET journalRevision=LAST_INSERT_ID();
  DELETE FROM snapshot_journal_events WHERE revision=journalRevision;
  IF journalRevision>journalCeiling THEN
    INSERT IGNORE INTO snapshot_journal_invalid(id,reason) VALUES(1,IF(journalRevision>${MAX_SNAPSHOT_JOURNAL_REVISION},'revision-exhausted','capacity-exhausted'));
    SET journalEnabled=FALSE;
  END IF;
END IF; `

/** Fresh owned fixture/installation only; registered partial-DDL recovery is separate. */
export async function installSnapshotJournalMysqlClock(k: Knex, ceiling: SnapshotJournalRevision): Promise<void> {
  if (k.client.config.client !== 'mysql' && k.client.config.client !== 'mysql2') {
    throw new WERR_INVALID_OPERATION('Snapshot journal clock requires MySQL')
  }
  if (snapshotJournalRevision(ceiling) === '0') throw new WERR_INVALID_OPERATION('Empty snapshot journal event window')
  await runInSeries(SNAPSHOT_JOURNAL_MYSQL_CLOCK_DDL, async statement => {
    await k.raw(statement)
  })
  await k('snapshot_journal_clock').insert({ id: 1, ceiling })
}
