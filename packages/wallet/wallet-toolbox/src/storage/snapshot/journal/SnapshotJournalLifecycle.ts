import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { copySnapshotJournalBootstrapPage } from './SnapshotJournalBootstrap'
import { snapshotJournalReceiptPolicy, type SnapshotJournalReceiptPolicy } from './SnapshotJournalReceipt'
import {
  MAX_SNAPSHOT_JOURNAL_REVISION,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import {
  installSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration,
  readSnapshotJournalSqliteGeneration,
  dropSnapshotJournalSqliteForDataDeletion
} from './SnapshotJournalSqliteGeneration'
import {
  installSnapshotJournalMysqlGeneration,
  completeSnapshotJournalMysqlGeneration,
  readSnapshotJournalMysqlGeneration,
  dropSnapshotJournalMysqlForDataDeletion
} from './SnapshotJournalMysqlGeneration'

export const SNAPSHOT_JOURNAL_SOURCE_MIGRATION = '2026-10-06-002 add native snapshot journal'
export const SNAPSHOT_JOURNAL_DEFAULT_POLICY: Readonly<SnapshotJournalReceiptPolicy> = Object.freeze({
  receiptLimit: 128,
  receiptLifetimeMs: 1800000
})
export const SNAPSHOT_JOURNAL_DEFAULT_BOOTSTRAP_ROWS = 2147483647
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Native journal lifecycle requires an owned supported backend')
}
function mysql(k: Knex): boolean {
  if (['mysql', 'mysql2'].includes(String(k.client.config.client))) return true
  if (['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) || isOwnedNativeSqlite(k)) return false
  invalid()
}
interface Configuration {
  ceiling: SnapshotJournalRevision
  policy: SnapshotJournalReceiptPolicy
  bootstrapRows: number
}

/** Read installation policy DATA freshly; complete physical/schema/generation
 * validation is performed independently by the lifecycle/capture operation. */
async function configuration(k: Knex): Promise<Configuration> {
  const remote = mysql(k)
  if (!(await k.schema.hasTable('snapshot_journal_generation')))
    return {
      ceiling: snapshotJournalRevision(MAX_SNAPSHOT_JOURNAL_REVISION),
      policy: { ...SNAPSHOT_JOURNAL_DEFAULT_POLICY },
      bootstrapRows: SNAPSHOT_JOURNAL_DEFAULT_BOOTSTRAP_ROWS
    }
  const rows: Array<{ ceiling: unknown }> = await k('snapshot_journal_generation')
    .where('id', 1)
    .select(
      k.raw(
        remote
          ? 'CASE WHEN octet_length(ceiling) BETWEEN 1 AND 19 THEN ceiling ELSE NULL END AS ceiling'
          : "CASE WHEN typeof(ceiling)='text' AND length(ceiling) BETWEEN 1 AND 19 THEN ceiling ELSE NULL END AS ceiling"
      )
    )
    .limit(2)
  if (rows.length !== 1) invalid()
  const ceiling = snapshotJournalRevision(rows[0].ceiling)
  let policy: SnapshotJournalReceiptPolicy = { ...SNAPSHOT_JOURNAL_DEFAULT_POLICY }
  if (await k.schema.hasTable('snapshot_journal_retention')) {
    const values: Array<{ receiptLimit: unknown; receiptLifetimeMs: unknown }> = await k('snapshot_journal_retention')
      .where('id', 1)
      .select('receiptLimit', 'receiptLifetimeMs')
      .limit(2)
    if (values.length !== 1) invalid()
    policy = snapshotJournalReceiptPolicy({
      receiptLimit: Number(values[0].receiptLimit),
      receiptLifetimeMs: Number(values[0].receiptLifetimeMs)
    })
  }
  let bootstrapRows = SNAPSHOT_JOURNAL_DEFAULT_BOOTSTRAP_ROWS
  if (await k.schema.hasTable('snapshot_journal_bootstrap')) {
    const values: Array<{ rowLimit: unknown }> = await k('snapshot_journal_bootstrap')
      .where('id', 1)
      .select('rowLimit')
      .limit(2)
    if (values.length !== 1) invalid()
    if (values[0].rowLimit !== null) {
      const n = Number(values[0].rowLimit)
      if (!Number.isSafeInteger(n) || n < 0 || n > SNAPSHOT_JOURNAL_DEFAULT_BOOTSTRAP_ROWS) invalid()
      bootstrapRows = n
    }
  }
  return { ceiling, policy, bootstrapRows }
}

/** Registered forward migration. Bootstrap retains a durable keyset and explicit
 * total row allowance. Each page freshly checks source/object ownership and
 * releases its writer before the next page; complete is set only after all17
 * source/index streams finish. No migration entry or stored flag alone admits a
 * runtime source. An interrupted migration resumes these same owned objects.
 */
export async function migrateSnapshotJournalSource(k: Knex): Promise<void> {
  if (k.isTransaction) invalid()
  const remote = mysql(k),
    config = await configuration(k)
  let state = remote
    ? await installSnapshotJournalMysqlGeneration(k, config.ceiling, config.policy, k.client.config.migrations)
    : await installSnapshotJournalSqliteGeneration(k, config.ceiling, config.policy, k.client.config.migrations)
  if (!state.enabled) invalid()
  while (!state.complete) {
    const current = remote
      ? await readSnapshotJournalMysqlGeneration(k, config.ceiling, config.policy, k.client.config.migrations)
      : await readSnapshotJournalSqliteGeneration(k, config.policy, k.client.config.migrations)
    if (!current.enabled || current.epoch !== state.epoch || current.source !== state.source) invalid()
    const page = await copySnapshotJournalBootstrapPage(k, config.bootstrapRows)
    if (page.invalidated) invalid()
    if (page.complete)
      state = remote
        ? await completeSnapshotJournalMysqlGeneration(k, config.ceiling, config.policy, k.client.config.migrations)
        : await completeSnapshotJournalSqliteGeneration(k, config.policy, k.client.config.migrations)
    if (!state.complete) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

/** Actual complete current source, including the registered migration, before
 * returning capture configuration. Configuration remains data and the capture
 * repeats all physical/profile/receipt checks in its own coherent view. */
export async function readSnapshotJournalCaptureConfiguration(
  k: Knex
): Promise<{ ceiling: SnapshotJournalRevision; receiptPolicy: SnapshotJournalReceiptPolicy }> {
  const config = await configuration(k),
    remote = mysql(k)
  const migrationTable = k.client.config.migrations?.tableName ?? 'knex_migrations'
  const rows = await k(migrationTable).where('name', SNAPSHOT_JOURNAL_SOURCE_MIGRATION).select('name').limit(2)
  if (rows.length !== 1) invalid()
  const actual = remote
    ? await readSnapshotJournalMysqlGeneration(k, config.ceiling, config.policy, k.client.config.migrations)
    : await readSnapshotJournalSqliteGeneration(k, config.policy, k.client.config.migrations)
  if (!actual.complete || !actual.enabled) invalid()
  return { ceiling: config.ceiling, receiptPolicy: { ...config.policy } }
}

/** Current configuration DATA for automatic housekeeping. Every subsequent
 * bounded maintenance writer independently repeats complete native generation,
 * physical backend, schema, policy and epoch checks before modifying metadata. */
export async function readSnapshotJournalMaintenanceConfiguration(k: Knex): Promise<{
  ceiling: SnapshotJournalRevision
  receiptPolicy: SnapshotJournalReceiptPolicy
  epoch: string
}> {
  const current = await readSnapshotJournalCaptureConfiguration(k)
  const actual = mysql(k)
    ? await readSnapshotJournalMysqlGeneration(k, current.ceiling, current.receiptPolicy, k.client.config.migrations)
    : await readSnapshotJournalSqliteGeneration(k, current.receiptPolicy, k.client.config.migrations)
  if (!actual.complete || !actual.enabled) invalid()
  return { ...current, epoch: actual.epoch }
}

/** Explicit data erasure after the provider drains every retained source. This
 * checks owned physical definitions even for an interrupted installation; it
 * does not attempt a normal downgrade or reset the retained generation in place.
 */
export async function dropSnapshotJournalSourceForDataDeletion(k: Knex): Promise<void> {
  if (mysql(k))
    await dropSnapshotJournalMysqlForDataDeletion(k, { ...SNAPSHOT_JOURNAL_DEFAULT_POLICY }, k.client.config.migrations)
  else await dropSnapshotJournalSqliteForDataDeletion(k, k.client.config.migrations)
}
