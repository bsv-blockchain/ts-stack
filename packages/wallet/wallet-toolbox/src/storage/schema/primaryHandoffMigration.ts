import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import {
  snapshotComparisonReceiptSchema,
  snapshotComparisonReceiptDdl,
  verifySnapshotComparisonReceiptSchema
} from './snapshotSyncReceiptMigration'
import { verifySnapshotSyncPrimaryFence } from './snapshotSyncMigration'

export const PRIMARY_HANDOFF_MIGRATION = '2026-10-18-001 add durable primary handoff control'
export const PRIMARY_HANDOFF_TABLE = 'wallet_primary_handoffs'
export const PRIMARY_HANDOFF_COPIES = 'wallet_primary_copy_sources'
export const PRIMARY_HANDOFF_KEY = 'primary-control-v1'
const specification = snapshotComparisonReceiptSchema(PRIMARY_HANDOFF_TABLE, 'wallet_primary_handoffs_user', [
  ['userId', 'int', false],
  ['sourceKey', 'varchar(64)', false],
  ['version', 'int', false],
  ['operationId', 'varchar(32)', false],
  ['localStorageIdentityKey', 'varchar(130)', false],
  ['targetStorageIdentityKey', 'varchar(130)', false],
  ['side', 'varchar(6)', false],
  ['phase', 'varchar(16)', false],
  ['sourceEpoch', 'varchar(19)', true],
  ['localEpoch', 'varchar(19)', false],
  ['plan', 'varchar(8192)', true],
  ['roleGateFrom', 'varchar(130)', true],
  ['roleGateTo', 'varchar(130)', true],
  ['roleGateEpoch', 'varchar(19)', true]
])
const copies = snapshotComparisonReceiptSchema(PRIMARY_HANDOFF_COPIES, 'wallet_primary_copy_sources_user', [
  ['userId', 'int', false],
  ['sourceKey', 'varchar(64)', false],
  ['version', 'int', false],
  ['operationId', 'varchar(32)', false],
  ['sourceStorageIdentityKey', 'varchar(130)', false],
  ['sourceEpoch', 'varchar(19)', false],
  ['activeStorage', 'varchar(130)', false],
  ['sessionId', 'varchar(64)', false],
  ['sourceMetadata', 'varchar(64)', false]
])
const guard = 'wallet_primary_control_guard',
  consume = 'wallet_primary_control_consume'
const exists = `SELECT 1 FROM ${PRIMARY_HANDOFF_TABLE} h WHERE h.userId=OLD.userId AND h.sourceKey='${PRIMARY_HANDOFF_KEY}'`
const epoch = '(SELECT epoch FROM snapshot_sync_primary_epochs WHERE userId=OLD.userId)'
export const primaryHandoffSqliteGuard = `CREATE TRIGGER ${guard} BEFORE UPDATE OF activeStorage ON users
 WHEN OLD.activeStorage IS NOT NEW.activeStorage AND EXISTS(${exists}) AND NOT EXISTS(${exists}
 AND h.roleGateFrom=OLD.activeStorage AND h.roleGateTo=NEW.activeStorage
 AND h.roleGateEpoch=CAST(COALESCE(${epoch},0) AS TEXT))
 BEGIN SELECT RAISE(ABORT,'Coordinated primary control required for enrolled wallet'); END`
export const primaryHandoffSqliteConsume = `CREATE TRIGGER ${consume} AFTER UPDATE OF activeStorage ON users
 WHEN OLD.activeStorage IS NOT NEW.activeStorage BEGIN UPDATE ${PRIMARY_HANDOFF_TABLE}
 SET roleGateFrom=NULL,roleGateTo=NULL,roleGateEpoch=NULL WHERE userId=NEW.userId AND sourceKey='${PRIMARY_HANDOFF_KEY}'; END`
export const primaryHandoffMysqlGuard = `BEGIN IF NOT (OLD.activeStorage <=> NEW.activeStorage) AND EXISTS(${exists})
 AND NOT EXISTS(${exists} AND h.roleGateFrom=OLD.activeStorage AND h.roleGateTo=NEW.activeStorage
 AND h.roleGateEpoch=CAST(COALESCE(${epoch},0) AS CHAR)) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coordinated primary control required for enrolled wallet'; END IF; END`
export const primaryHandoffMysqlConsume = `BEGIN IF NOT (OLD.activeStorage <=> NEW.activeStorage) THEN
 UPDATE ${PRIMARY_HANDOFF_TABLE} SET roleGateFrom=NULL,roleGateTo=NULL,roleGateEpoch=NULL
 WHERE userId=NEW.userId AND sourceKey='${PRIMARY_HANDOFF_KEY}'; END IF; END`
function remote(k: Knex): boolean {
  return String(k.client.config.client).includes('mysql')
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Primary handoff control schema is incomplete or changed')
}
const definitions = (k: Knex) =>
  remote(k)
    ? [
        { name: guard, timing: 'BEFORE', body: primaryHandoffMysqlGuard },
        { name: consume, timing: 'AFTER', body: primaryHandoffMysqlConsume }
      ]
    : [
        { name: guard, timing: 'BEFORE', body: primaryHandoffSqliteGuard },
        { name: consume, timing: 'AFTER', body: primaryHandoffSqliteConsume }
      ]
export async function verifyPrimaryHandoffSchema(k: Knex): Promise<void> {
  await verifySnapshotSyncPrimaryFence(k)
  await verifySnapshotComparisonReceiptSchema(k, specification)
  await verifySnapshotComparisonReceiptSchema(k, copies)
  await verifyPrimaryHandoffTriggers(k)
}
/** Exact authored additions only. Partial mode is exclusively the fixed MySQL
 * forward migration; it still rejects any present altered trigger or context. */
export async function verifyPrimaryHandoffTriggers(k: Knex, complete = true, migrationContext = false): Promise<void> {
  for (const expected of definitions(k)) {
    if (!remote(k)) {
      const rows = await k('sqlite_master')
        .where({ name: expected.name, type: 'trigger', tbl_name: 'users' })
        .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [expected.body])
        .select('name')
        .limit(2)
      const shadows = await k('sqlite_temp_master')
        .where({ type: 'trigger', tbl_name: 'users' })
        .select('name')
        .limit(1)
      if (rows.length !== 1 || shadows.length !== 0) invalid()
    } else {
      const [rows]: Array<
        Array<{
          ACTION_STATEMENT: string
          ACTION_TIMING: string
          EVENT_OBJECT_TABLE: string
          EVENT_MANIPULATION: string
          ACTION_ORIENTATION: string
        }>
      > = await k.raw(
        'SELECT ACTION_STATEMENT,ACTION_TIMING,EVENT_OBJECT_TABLE,EVENT_MANIPULATION,ACTION_ORIENTATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=? AND OCTET_LENGTH(ACTION_STATEMENT)<=4096 LIMIT 2',
        [expected.name]
      )
      if (rows.length === 0 && !complete) continue
      const row = rows[0],
        normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
      if (migrationContext) {
        const [contexts]: Array<Array<Record<string, unknown>>> = await k.raw(
          'SELECT CURRENT_USER() definer,@@SESSION.sql_mode sqlMode,@@SESSION.character_set_client charset,@@SESSION.collation_connection connectionCollation,@@collation_database databaseCollation'
        )
        const [actual]: Array<Array<Record<string, unknown>>> = await k.raw(
          'SELECT DEFINER definer,SQL_MODE sqlMode,CHARACTER_SET_CLIENT charset,COLLATION_CONNECTION connectionCollation,DATABASE_COLLATION databaseCollation FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=? LIMIT 2',
          [expected.name]
        )
        if (
          contexts.length !== 1 ||
          actual.length !== 1 ||
          Object.keys(contexts[0]).some(key => contexts[0][key] !== actual[0][key])
        )
          invalid()
      }
      if (
        rows.length !== 1 ||
        row.ACTION_TIMING !== expected.timing ||
        row.EVENT_OBJECT_TABLE !== 'users' ||
        row.EVENT_MANIPULATION !== 'UPDATE' ||
        row.ACTION_ORIENTATION !== 'ROW' ||
        normalize(row.ACTION_STATEMENT) !== normalize(expected.body)
      )
        invalid()
    }
  }
}
export async function addPrimaryHandoffSchema(k: Knex): Promise<void> {
  if (!(await k.schema.hasTable(PRIMARY_HANDOFF_TABLE))) await k.raw(snapshotComparisonReceiptDdl(k, specification))
  if (!(await k.schema.hasTable(PRIMARY_HANDOFF_COPIES))) await k.raw(snapshotComparisonReceiptDdl(k, copies))
  for (const expected of definitions(k)) {
    const found = remote(k)
      ? (
          await k.raw(
            'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=? LIMIT 1',
            [expected.name]
          )
        )[0]
      : await k('sqlite_master').where({ name: expected.name, type: 'trigger' }).select('name').limit(1)
    if (found.length === 0)
      await k.raw(
        remote(k)
          ? `CREATE TRIGGER ${expected.name} ${expected.timing} UPDATE ON users FOR EACH ROW ${expected.body}`
          : expected.body
      )
  }
  await verifyPrimaryHandoffSchema(k)
}
export async function removePrimaryHandoffSchema(k: Knex): Promise<void> {
  if (!(await k.schema.hasTable(PRIMARY_HANDOFF_TABLE))) return
  await verifyPrimaryHandoffSchema(k)
  // MySQL DDL commits implicitly. An emptiness probe cannot fence concurrent
  // enrollment through trigger removal; keep the guard and recover forward.
  throw new WERR_INVALID_OPERATION('Primary control requires forward recovery; preserve handoff intent and guards')
}

/** Explicit full wallet erasure only, after the provider drains its owners.
 * Ordinary migration rollback remains forward-only, even for empty controls.
 * Verify every current definition before deleting this auxiliary family. */
export async function dropPrimaryHandoffForDataDeletion(k: Knex): Promise<void> {
  if (!(await k.schema.hasTable(PRIMARY_HANDOFF_TABLE))) {
    if (await k.schema.hasTable(PRIMARY_HANDOFF_COPIES)) invalid()
    return
  }
  await verifyPrimaryHandoffSchema(k)
  for (const definition of definitions(k)) await k.raw('DROP TRIGGER ??', [definition.name])
  await k.schema.dropTable(PRIMARY_HANDOFF_COPIES)
  await k.schema.dropTable(PRIMARY_HANDOFF_TABLE)
}
