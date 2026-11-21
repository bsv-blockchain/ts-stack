/** Recovery definitions are DATA. Actual ownership, disabled epoch and fresh
 * source/primary admission are checked by the native recovery controller. */
export const brc38NativeLocalEpochRecoveryTable = 'brc38_native_local_epoch_recovery'
const recovery = brc38NativeLocalEpochRecoveryTable,
  clock = 'brc38_local_baseline_clock',
  rows = 'brc38_local_baseline_rows'
export const brc38NativeLocalEpochRecoveryDefinitions = Object.freeze([
  `CREATE TABLE ${recovery}(slot INTEGER PRIMARY KEY CHECK(slot=1),protocol TEXT NOT NULL CHECK(protocol='brc38-local-epoch-recovery/v1'),oldEpoch TEXT NOT NULL CHECK(length(CAST(oldEpoch AS BLOB))=36),newEpoch TEXT NOT NULL CHECK(length(CAST(newEpoch AS BLOB))=36 AND newEpoch!=oldEpoch),maximumRows INTEGER NOT NULL CHECK(typeof(maximumRows)='integer' AND maximumRows BETWEEN 1 AND 10000000),ceiling INTEGER NOT NULL CHECK(typeof(ceiling)='integer' AND ceiling>0),phase TEXT NOT NULL CHECK(phase IN ('DRAINING','READY','COMPLETE')))`,
  `CREATE TRIGGER ${recovery}_update BEFORE UPDATE ON ${recovery} WHEN NEW.slot IS NOT OLD.slot OR NEW.protocol IS NOT OLD.protocol OR NEW.oldEpoch IS NOT OLD.oldEpoch OR NEW.newEpoch IS NOT OLD.newEpoch OR NEW.maximumRows IS NOT OLD.maximumRows OR NEW.ceiling IS NOT OLD.ceiling OR NOT ((OLD.phase='DRAINING' AND NEW.phase='READY' AND NOT EXISTS(SELECT 1 FROM ${rows} LIMIT 1) AND EXISTS(SELECT 1 FROM ${clock} WHERE slot=1 AND epoch=OLD.oldEpoch AND enabled=0 AND records=0)) OR (OLD.phase='READY' AND NEW.phase='COMPLETE' AND EXISTS(SELECT 1 FROM ${clock} WHERE slot=1 AND epoch=OLD.newEpoch AND enabled=1 AND revision=0 AND records=0 AND complete=0 AND bootstrapTable=0 AND afterRowId IS NULL))) BEGIN SELECT RAISE(ABORT,'Local epoch recovery transition differs'); END`,
  `CREATE TRIGGER ${recovery}_delete BEFORE DELETE ON ${recovery} WHEN OLD.phase!='COMPLETE' OR NOT EXISTS(SELECT 1 FROM ${clock} WHERE slot=1 AND epoch=OLD.newEpoch AND enabled=0) BEGIN SELECT RAISE(ABORT,'Local epoch recovery remains owned'); END`
])
/** Optional guard variant permits only a disabled epoch's finite metadata
 * retirement, or its exact READY recovery reset after every old point is gone.
 * Normal active epoch transitions retain the original monotonic rules. */
export function brc38NativeLocalEpochRecoverySourceDefinitions(base: readonly string[]): readonly string[] {
  const unchanged = [
      'slot',
      'protocol',
      'epoch',
      'revision',
      'ceiling',
      'maximumRows',
      'enabled',
      'reason',
      'bootstrapTable',
      'afterRowId',
      'complete'
    ]
      .map(field => `NEW.${field} IS OLD.${field}`)
      .join(' AND '),
    decrement = `OLD.enabled=0 AND NEW.records=OLD.records-1 AND OLD.records>0 AND ${unchanged} AND EXISTS(SELECT 1 FROM ${recovery} WHERE slot=1 AND oldEpoch=OLD.epoch AND phase='DRAINING')`,
    reset = `OLD.enabled=0 AND NEW.slot IS OLD.slot AND NEW.protocol IS OLD.protocol AND NEW.revision=0 AND NEW.records=0 AND NEW.enabled=1 AND NEW.reason IS NULL AND NEW.complete=0 AND NEW.bootstrapTable=0 AND NEW.afterRowId IS NULL AND NOT EXISTS(SELECT 1 FROM ${rows} LIMIT 1) AND EXISTS(SELECT 1 FROM ${recovery} WHERE slot=1 AND oldEpoch=OLD.epoch AND newEpoch=NEW.epoch AND maximumRows=NEW.maximumRows AND ceiling=NEW.ceiling AND phase='READY')`,
    result = base.map(sql => {
      if (sql.startsWith('CREATE TRIGGER brc38_local_baseline_clock_update_guard ')) {
        const match =
          /^(CREATE TRIGGER brc38_local_baseline_clock_update_guard BEFORE UPDATE ON brc38_local_baseline_clock) WHEN (.+) BEGIN (.+)$/.exec(
            sql
          )
        if (match === null) throw new Error('Local recovery clock source definition differs')
        return `${match[1]} WHEN (${match[2]}) AND NOT ((${decrement}) OR (${reset})) BEGIN ${match[3]}`
      }
      if (sql.startsWith('CREATE TRIGGER brc38_local_baseline_rows_delete_guard '))
        return `CREATE TRIGGER brc38_local_baseline_rows_delete_guard BEFORE DELETE ON ${rows} WHEN NOT EXISTS(SELECT 1 FROM ${recovery} r JOIN ${clock} c ON c.slot=r.slot WHERE r.slot=1 AND r.oldEpoch=c.epoch AND c.enabled=0 AND c.records>0 AND r.phase='DRAINING') BEGIN SELECT RAISE(ABORT,'Local baseline tombstone is retained by its epoch'); END`
      return sql
    })
  result.push(
    `CREATE TRIGGER brc38_local_baseline_rows_delete_charge AFTER DELETE ON ${rows} BEGIN UPDATE ${clock} SET records=records-1 WHERE slot=1; END`
  )
  return Object.freeze(result)
}
