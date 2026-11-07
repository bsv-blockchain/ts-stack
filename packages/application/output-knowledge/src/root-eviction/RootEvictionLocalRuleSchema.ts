import { outputAssert, outputU64 } from '@bsv/sdk'
import { rootDecimal } from './RootEvictionCodec.js'
import type { SQLiteRootEvictionDatabase } from './SQLiteRootEvictionDatabase.js'

/** Static owned SQL; format3 only. Ordinary opens never manufacture missing history. */
export const ROOT_LOCAL_RULE_SCHEMA = `
  CREATE TABLE root_rule_meta (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL) STRICT;
  INSERT INTO root_rule_meta VALUES (1,'0000000000000000');
  CREATE TABLE root_local_rules (
    decision TEXT PRIMARY KEY, rule TEXT NOT NULL, bytes INTEGER NOT NULL,
    policy TEXT NOT NULL, revision TEXT NOT NULL, lifted_by TEXT
  ) STRICT;
  CREATE TABLE root_rule_coverage (
    target_key TEXT PRIMARY KEY REFERENCES root_views(target_key), epoch TEXT NOT NULL
  ) STRICT;
  CREATE TABLE root_rule_bindings (
    target_key TEXT NOT NULL REFERENCES root_views(target_key),
    decision TEXT NOT NULL REFERENCES root_local_rules(decision),
    PRIMARY KEY(target_key,decision)
  ) STRICT;
`

/** Reserve all active rules, even before knowing which match a particular advertisement. */
export function rootLocalRuleReservation(
  database: SQLiteRootEvictionDatabase,
  peerCount: number
): void {
  if (!database.configuration.localRules) return
  const active = Number(
    database.get('SELECT count(*) AS n FROM root_local_rules WHERE lifted_by IS NULL')!.n
  )
  outputAssert(
    Number.isSafeInteger(active) && active + peerCount <= database.configuration.capacity.blockers,
    'Root local-rule and peer-basis capacity is full',
    'limited'
  )
}

export function rootLocalRuleInventory(database: SQLiteRootEvictionDatabase): void {
  const limits = database.configuration.localRules!
  rootDecimal(database.get('SELECT epoch FROM root_rule_meta WHERE id=1')?.epoch)
  const row = database.get(
    'SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM root_local_rules'
  )!
  outputAssert(
    Number.isSafeInteger(row.n) &&
      Number(row.n) <= limits.rules &&
      Number.isSafeInteger(row.bytes) &&
      Number(row.bytes) >= 0 &&
      Number(row.bytes) <= limits.bytes &&
      !database.get(
        `SELECT 1 FROM root_local_rules WHERE bytes<1 OR bytes>16384 OR bytes!=length(CAST(rule AS BLOB)) LIMIT 1`
      ),
    'Root local-rule history accounting failed',
    'unavailable'
  )
  const epoch = database.get('SELECT epoch FROM root_rule_meta WHERE id=1')!.epoch as string
  outputAssert(
    !database.get(
      `SELECT 1 FROM root_rule_coverage WHERE length(epoch)!=16 OR epoch GLOB '*[^0-9a-f]*' OR epoch>? LIMIT 1`,
      epoch
    ) &&
      !database.get(
        'SELECT target_key FROM root_rule_bindings GROUP BY target_key HAVING count(*)>? LIMIT 1',
        database.configuration.capacity.blockers
      ),
    'Root local-rule coverage accounting failed',
    'unavailable'
  )
  const peerCount = Number(
    database.get(`SELECT coalesce(max(n),0) AS n FROM
    (SELECT count(*) AS n FROM root_bases WHERE lifted_by IS NULL GROUP BY target_key)`)!.n
  )
  rootLocalRuleReservation(database, peerCount)
}

/** Preserve the ability to lift every active rule and durably withdraw its views. */
export function rootLocalRuleCompletionReservation(database: SQLiteRootEvictionDatabase): bigint {
  if (!database.configuration.localRules) return 0n
  const row = database.get(`SELECT
    (SELECT count(*) FROM root_local_rules WHERE lifted_by IS NULL) AS active,
    (SELECT count(*) FROM root_assessments) AS assessments,
    (SELECT count(*) FROM root_views) AS views`)!
  const active = Number(row.active)
  outputAssert(
    Number(row.assessments) + active <= database.configuration.capacity.assessments,
    'Root local rules cannot reserve future lift history',
    'limited'
  )
  const epoch = rootDecimal(database.get('SELECT epoch FROM root_rule_meta WHERE id=1')?.epoch)
  outputAssert(
    outputU64(epoch) + BigInt(active) <= 18446744073709551615n,
    'Root local rules cannot reserve future lift epochs',
    'limited'
  )
  return BigInt(active) * (1n + BigInt(Number(row.views)))
}
