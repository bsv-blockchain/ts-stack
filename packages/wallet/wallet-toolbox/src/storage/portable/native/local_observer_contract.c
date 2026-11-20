/* Additive actual-kernel contract, with independently authored coordinates.
 * The original private-stage observer and all other component bodies remain
 * unchanged. This transport proof does not qualify the full wallet journal. */
static sqlite3_int64 localObserverValue(const char *sql) {
  sqlite3_stmt *statement = NULL;
  profileRequire(sqlite3_prepare_v2(driverDb[0], sql, -1, &statement, NULL) == SQLITE_OK,
                 "local observer independent scalar prepared");
  profileRequire(sqlite3_step(statement) == SQLITE_ROW, "local observer independent scalar observed");
  sqlite3_int64 result = sqlite3_column_int64(statement, 0);
  profileRequire(sqlite3_step(statement) == SQLITE_DONE && sqlite3_finalize(statement) == SQLITE_OK,
                 "local observer independent scalar physically drained");
  return result;
}
static int localObserverContracts(void) {
  const char *root = "/work/local-observer-contract";
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
  const char *names[] = {"insert", "delete", "update"};
  const char *events[] = {"INSERT", "DELETE", "UPDATE"};
  for (int form = 0; form < 2; form++) {
    for (int event = 0; event < 3; event++) {
      char sql[512];
      int size = snprintf(sql, sizeof(sql),
        "CREATE TRIGGER brc38_local_baseline_monitor_events_%s AFTER %s ON monitor_events BEGIN "
        "INSERT INTO brc38_local_baseline_event%s VALUES(15,%s,%s,%d); END",
        names[event], events[event], form == 0 ? "(tableId,oldRowId,newRowId,present)" : "",
        event == 0 ? "NULL" : "OLD.rowid", event == 1 ? "NULL" : "NEW.rowid", event == 1 ? 0 : 1);
      profileRequire(size > 0 && size < (int)sizeof(sql) && controlSql(driverDb[0], sql) == SQLITE_OK,
                     "local observer independent exact old/new form installed");
    }
    profileRequire(sqlite3_exec(driverDb[0],
      "INSERT INTO monitor_events VALUES(-5);UPDATE monitor_events SET id=-7;DELETE FROM monitor_events",
      NULL, NULL, NULL) == SQLITE_OK, "local observer all three actual physical transitions");
    profileRequire(localObserverValue(
      "SELECT count(*) FROM independent_local_coordinates WHERE tableId=15 AND ("
      "(oldRowId IS NULL AND newRowId=-5 AND present=1) OR "
      "(oldRowId=-5 AND newRowId=-7 AND present=1) OR "
      "(oldRowId=-7 AND newRowId IS NULL AND present=0))") == 3 * (form + 1),
      "local observer independent insert/move/delete coordinate oracle");
    profileRequire(sqlite3_exec(driverDb[0],
      "SAVEPOINT local_observer_rollback;INSERT INTO monitor_events VALUES(9);"
      "ROLLBACK TO local_observer_rollback;RELEASE local_observer_rollback", NULL, NULL, NULL) == SQLITE_OK &&
      localObserverValue("SELECT count(*) FROM monitor_events") == 0 &&
      localObserverValue("SELECT count(*) FROM independent_local_coordinates") == 3 * (form + 1),
      "local observer source and coordinates roll back together");
    profileRequire(controlSql(driverDb[0],
      "DROP TRIGGER brc38_local_baseline_monitor_events_insert;"
      "DROP TRIGGER brc38_local_baseline_monitor_events_delete;"
      "DROP TRIGGER brc38_local_baseline_monitor_events_update") == SQLITE_OK,
      "local observer owned form physically retired");
  }
  profileRequire(controlSql(driverDb[0],
    "CREATE TRIGGER brc38_local_baseline_monitor_events_insert AFTER INSERT ON monitor_events BEGIN "
    "INSERT INTO brc38_local_baseline_event VALUES(15,NULL,NEW.rowid,1); END") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "INSERT INTO brc38_local_baseline_event VALUES(15,NULL,9,1)",
      NULL, NULL, NULL) == SQLITE_AUTH,
    "local observer direct event refused on fixed candidate");
  driverFamily = 1;
  profileRequire(sqlite3_exec(driverDb[0], "INSERT INTO monitor_events VALUES(9)",
    NULL, NULL, NULL) == SQLITE_AUTH, "local observer foreign family refused");
  driverFamily = 0;
  profileRequire(controlSql(driverDb[0],
    "CREATE TEMP TRIGGER brc38_local_baseline_monitor_events_insert AFTER INSERT ON main.monitor_events BEGIN SELECT 1; END") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "INSERT INTO monitor_events VALUES(9)", NULL, NULL, NULL) == SQLITE_AUTH &&
    localObserverValue("SELECT count(*) FROM monitor_events") == 0 &&
    localObserverValue("SELECT count(*) FROM independent_local_coordinates") == 6,
    "local observer fresh same-name temporary shadow refused without mutation");
  profileRequire(controlSql(driverDb[0],
    "DROP TRIGGER temp.brc38_local_baseline_monitor_events_insert") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "INSERT INTO monitor_events VALUES(9)", NULL, NULL, NULL) == SQLITE_OK,
    "local observer shadow removal permits fresh genuine emitter");
  profileRequire(controlSql(driverDb[0],
    "CREATE TABLE transactions(transactionId INTEGER PRIMARY KEY);"
    "CREATE TABLE brc38_native_binary_fields(tableId,rowId);"
    "CREATE TABLE brc38_native_text_fields(tableId,rowId);"
    "INSERT INTO transactions VALUES(42);"
    "CREATE TRIGGER brc38_local_baseline_packed_binary_0_INSERT AFTER INSERT ON brc38_native_binary_fields "
    "WHEN NEW.tableId=0 AND EXISTS(SELECT 1 FROM transactions s WHERE s.transactionId=NEW.rowId) "
    "BEGIN INSERT INTO brc38_local_baseline_event VALUES(7,NULL,(SELECT s.rowid FROM transactions s WHERE s.transactionId=NEW.rowId),1); END;"
    "CREATE TRIGGER brc38_local_baseline_packed_text_13_DELETE AFTER DELETE ON brc38_native_text_fields "
    "WHEN OLD.tableId=13 AND EXISTS(SELECT 1 FROM monitor_events s WHERE s.id=OLD.rowId) "
    "BEGIN INSERT INTO brc38_local_baseline_event VALUES(15,NULL,(SELECT s.rowid FROM monitor_events s WHERE s.id=OLD.rowId),1); END;"
    "INSERT INTO brc38_native_text_fields VALUES(13,9)") == SQLITE_OK &&
    sqlite3_exec(driverDb[0],
      "INSERT INTO brc38_native_binary_fields VALUES(0,42);DELETE FROM brc38_native_text_fields",
      NULL, NULL, NULL) == SQLITE_OK &&
    localObserverValue("SELECT count(*) FROM independent_local_coordinates WHERE tableId=7 AND oldRowId IS NULL AND newRowId=42 AND present=1") == 1 &&
    localObserverValue("SELECT count(*) FROM independent_local_coordinates WHERE tableId=15 AND oldRowId IS NULL AND newRowId=9 AND present=1") == 2 &&
    localObserverValue("SELECT count(*) FROM brc38_local_baseline_event") == 0,
    "local observer independent positional packed source coordinates and rowless dispatch");
  profileRequire(closeNative(0) == SQLITE_OK && brc38QuotaClose(&driverQuota) == SQLITE_OK,
                 "local observer database and VFS physically drained");
  profileRemove(root);
  profileRequire(sqlite3_memory_highwater(0) <= 4194304 && sqlite3_shutdown() == SQLITE_OK,
                 "local observer unchanged heap ceiling and actual SQLite shutdown");
  printf("PASS independent local observer forms checks=%d fixturesDrained=true\n", profileChecks);
  return 0;
}
