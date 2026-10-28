/* Independent full source-coordinate and native authorization oracle. */
static int localObserverNamesContracts(void) {
  const char *root = "/work/local-observer-names-contract";
  profileRequire(brc38NativeRuntimeInitialize(67108864, 4194304, 32) == SQLITE_OK,
                 "local observer unchanged native runtime ceilings");
  profileRequire(mkdir(root, 0700) == 0, "local observer new private fixture directory");
  Brc38ProfileEnrollment expected = {0}; struct stat actual;
  profileRequire(lstat(root, &actual) == 0, "local observer actual directory identity");
  expected.directoryDevice = actual.st_dev; expected.directoryInode = actual.st_ino;
  for (int family = 0; family < 3; family++) {
    char path[PATH_MAX];
    profileRequire(snprintf(path, sizeof(path), "%s/%s", root, brc38Names[family * 4]) < (int)sizeof(path),
                   "local observer bounded original family path");
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    profileRequire(fd >= 0 && fstat(fd, &actual) == 0, "local observer actual enrollment descriptor");
    expected.mainDevice[family] = actual.st_dev; expected.mainInode[family] = actual.st_ino;
    profileRequire(close(fd) == 0, "local observer enrollment descriptor drained");
  }
  profileRequire(brc38ProfileQuotaInitialize(&driverQuota, root, 4194304, &expected) == SQLITE_OK &&
                 driverQuota.mainMaximum[0] == 330 * 4096,
                 "local observer unchanged exact page formula");
  driverFamily = 0;
  profileRequire(openNative(0, 0) == SQLITE_OK && controlSql(driverDb[0],
    "CREATE TABLE monitor_events(id INTEGER PRIMARY KEY);"
    "CREATE TABLE independent_local_coordinates(tableId,oldRowId,newRowId,present);"
    "CREATE VIEW brc38_local_baseline_event(tableId,oldRowId,newRowId,present) AS SELECT NULL,NULL,NULL,NULL WHERE 0;"
    "CREATE TRIGGER independent_coordinate_dispatch INSTEAD OF INSERT ON brc38_local_baseline_event BEGIN "
    "INSERT INTO independent_local_coordinates VALUES(NEW.tableId,NEW.oldRowId,NEW.newRowId,NEW.present); END") == SQLITE_OK,
    "local observer actual independent rowless dispatch fixture");
  static const char *sources[] = {
    "users",
    "settings",
    "proven_txs",
    "proven_tx_reqs",
    "output_baskets",
    "output_tags",
    "tx_labels",
    "transactions",
    "outputs",
    "commissions",
    "tx_labels_map",
    "output_tags_map",
    "certificates",
    "certificate_fields",
    "sync_states",
    "monitor_events",
    "prepared_beef_metadata",
    "prepared_beefs",
    "action_batches",
    "action_batch_outputs",
    "action_batch_blobs",
    "sync_transfers",
    "sync_transfer_parts",
    "auth_sessions",
    "auth_message_nonces",
    "payment_replays",
    "snapshot_sync_sessions",
    "snapshot_sync_ids",
    "snapshot_sync_primary_epochs",
    "snapshot_reconciliation_windows",
    "snapshot_reconciliation_stage_budgets",
    "snapshot_reconciliation_stage_pages",
    "snapshot_reconciliation_stage_chains",
    "snapshot_reconciliation_promotion_cursors",
    "snapshot_reconciliation_captured_identity_budgets",
    "snapshot_reconciliation_captured_identities",
    "snapshot_reconciliation_identity_frames",
    "snapshot_reconciliation_identity_budgets",
    "snapshot_reconciliation_identity_maps",
    "snapshot_reconciliation_identity_retirement_budgets",
    "snapshot_reconciliation_identity_retirements",
    "snapshot_reconciliation_membership_budgets",
    "snapshot_reconciliation_memberships",
    "snapshot_reconciliation_membership_retirements",
    "snapshot_reconciliation_provenance_budgets",
    "snapshot_reconciliation_provenance",
    "snapshot_reconciliation_window_progress",
  };

  const char *names[] = {"insert","delete","update"}, *events[] = {"INSERT","DELETE","UPDATE"};
  int transitions = 0;
  for (size_t source = 0; source < sizeof(sources)/sizeof(sources[0]); source++) {
    char sql[1536], trigger[192]; int amount;
    if (source != 15) {
      amount = snprintf(sql,sizeof(sql),"CREATE TABLE %s(id INTEGER PRIMARY KEY)",sources[source]);
      profileRequire(amount>0 && amount<(int)sizeof(sql) && controlSql(driverDb[0],sql)==SQLITE_OK,"observer names independent physical source");
    }
    for (int form = 0; form < 3; form++) {
      for(int event=0;event<3;event++) {
        amount=form==2?snprintf(trigger,sizeof(trigger),"brc38_local_baseline_s%zu_%s",source,names[event]):snprintf(trigger,sizeof(trigger),"brc38_local_baseline_%s_%s",sources[source],names[event]);
        profileRequire(amount>0 && amount<(int)sizeof(trigger),"observer names exact bounded name");
        amount=snprintf(sql,sizeof(sql),"CREATE TRIGGER %s AFTER %s ON %s BEGIN INSERT INTO brc38_local_baseline_event%s VALUES(%zu,%s,%s,%d); END",trigger,events[event],sources[source],form==0?"(tableId,oldRowId,newRowId,present)":"",source,event==0?"NULL":"OLD.rowid",event==1?"NULL":"NEW.rowid",event==1?0:1);
        profileRequire(amount>0 && amount<(int)sizeof(sql) && controlSql(driverDb[0],sql)==SQLITE_OK,"observer names independent exact emitter");
      }
      amount=snprintf(sql,sizeof(sql),"INSERT INTO %s VALUES(-5);UPDATE %s SET id=-7;DELETE FROM %s",sources[source],sources[source],sources[source]);
      profileRequire(amount>0 && amount<(int)sizeof(sql) && sqlite3_exec(driverDb[0],sql,NULL,NULL,NULL)==SQLITE_OK,"observer names all original physical transitions");
      transitions+=3;
      amount=snprintf(sql,sizeof(sql),"SELECT count(*) FROM independent_local_coordinates WHERE tableId=%zu AND ((oldRowId IS NULL AND newRowId=-5 AND present=1) OR (oldRowId=-5 AND newRowId=-7 AND present=1) OR (oldRowId=-7 AND newRowId IS NULL AND present=0))",source);
      profileRequire(amount>0 && amount<(int)sizeof(sql) && localObserverValue(sql)==3,"observer names independent complete physical oracle");
      amount=snprintf(sql,sizeof(sql),"SAVEPOINT names_rollback;INSERT INTO %s VALUES(9);ROLLBACK TO names_rollback;RELEASE names_rollback",sources[source]);
      profileRequire(amount>0 && amount<(int)sizeof(sql) && sqlite3_exec(driverDb[0],sql,NULL,NULL,NULL)==SQLITE_OK && localObserverValue("SELECT count(*) FROM independent_local_coordinates")==3,"observer names source and event rollback");
      for(int event=0;event<3;event++) {
        amount=form==2?snprintf(sql,sizeof(sql),"DROP TRIGGER brc38_local_baseline_s%zu_%s",source,names[event]):snprintf(sql,sizeof(sql),"DROP TRIGGER brc38_local_baseline_%s_%s",sources[source],names[event]);
        profileRequire(amount>0 && amount<(int)sizeof(sql) && controlSql(driverDb[0],sql)==SQLITE_OK,"observer names independent form retired");
      }
      profileRequire(controlSql(driverDb[0],"DELETE FROM independent_local_coordinates")==SQLITE_OK,"observer names point reset");
    }
  }
  profileRequire(transitions==423,"observer names all47 all141 three forms");
  profileRequire(controlSql(driverDb[0],"CREATE TRIGGER brc38_local_baseline_s15_insert AFTER INSERT ON monitor_events BEGIN INSERT INTO brc38_local_baseline_event VALUES(15,NULL,NEW.rowid,1); END")==SQLITE_OK,"observer names exact compact anchor");
  profileRequire(sqlite3_exec(driverDb[0],"INSERT INTO brc38_local_baseline_event VALUES(15,NULL,9,1)",NULL,NULL,NULL)==SQLITE_AUTH,"observer names direct event refused");
  profileRequire(controlSql(driverDb[0],"CREATE TEMP TRIGGER BRC38_LOCAL_BASELINE_S15_INSERT AFTER INSERT ON main.monitor_events BEGIN SELECT 1; END")==SQLITE_OK,"observer names case insensitive shadow");
  profileRequire(sqlite3_exec(driverDb[0],"INSERT INTO monitor_events VALUES(9)",NULL,NULL,NULL)==SQLITE_AUTH && localObserverValue("SELECT count(*) FROM monitor_events")==0,"observer names shadow refused atomically");
  profileRequire(controlSql(driverDb[0],"DROP TRIGGER temp.BRC38_LOCAL_BASELINE_S15_INSERT")==SQLITE_OK,"observer names shadow retired");
  driverRetiredRead=1;
  profileRequire(sqlite3_exec(driverDb[0],"INSERT INTO monitor_events VALUES(9)",NULL,NULL,NULL)==SQLITE_AUTH,"observer names retired actor refused");
  driverRetiredRead=0;driverCandidateComparison=1;
  profileRequire(sqlite3_exec(driverDb[0],"INSERT INTO monitor_events VALUES(9)",NULL,NULL,NULL)==SQLITE_AUTH,"observer names comparison actor refused");
  driverCandidateComparison=0;
  profileRequire(controlSql(driverDb[0],"DROP TRIGGER brc38_local_baseline_s15_insert;CREATE TRIGGER brc38_local_baseline_s15_insert AFTER INSERT ON monitor_events BEGIN INSERT INTO brc38_local_baseline_event VALUES(14,NULL,NEW.rowid,1); END")==SQLITE_OK,"observer names altered coordinate fixture");
  profileRequire(sqlite3_exec(driverDb[0],"INSERT INTO monitor_events VALUES(9)",NULL,NULL,NULL)==SQLITE_AUTH && localObserverValue("SELECT count(*) FROM monitor_events")==0,"observer names altered coordinate refused");
  profileRequire(controlSql(driverDb[0],"DROP TRIGGER brc38_local_baseline_s15_insert;CREATE TRIGGER brc38_local_baseline_s15_insert AFTER INSERT ON monitor_events BEGIN INSERT INTO brc38_local_baseline_event(tableId,oldRowId,newRowId,present) VALUES(15,NULL,NEW.rowid,1); END")==SQLITE_OK,"observer names unsupported named column fixture");
  profileRequire(sqlite3_exec(driverDb[0],"INSERT INTO monitor_events VALUES(9)",NULL,NULL,NULL)==SQLITE_AUTH,"observer names compact name only positional");
  profileRequire(closeNative(0)==SQLITE_OK && brc38QuotaClose(&driverQuota)==SQLITE_OK,"observer names physical kernel VFS drain");
  profileRemove(root);
  profileRequire(sqlite3_memory_highwater(0)<=4194304 && sqlite3_shutdown()==SQLITE_OK,"observer names original heap and shutdown");
  printf("PASS independent compact observer names sources=47 transitions=423 checks=%d fixturesDrained=true\n",profileChecks);
  return 0;
}
