/* Independent synthetic transport oracle for every fixed pointer coordinate.
 * The original nine component bodies remain unchanged. This does not establish
 * profile ownership, combined schema capacity or full wallet qualification. */
static int localPointerProjectionContracts(void) {
  const char *root = "/work/local-pointer-projection-contract";
  profileRequire(brc38NativeRuntimeInitialize(67108864, 4194304, 32) == SQLITE_OK,
                 "pointer projection unchanged native runtime ceilings");
  profileRequire(mkdir(root, 0700) == 0, "pointer projection new private fixture directory");
  Brc38ProfileEnrollment expected = {0}; struct stat actual;
  profileRequire(lstat(root, &actual) == 0, "pointer projection actual directory identity");
  expected.directoryDevice = actual.st_dev; expected.directoryInode = actual.st_ino;
  for (int family = 0; family < 3; family++) {
    char path[PATH_MAX];
    profileRequire(snprintf(path, sizeof(path), "%s/%s", root, brc38Names[family * 4]) < (int)sizeof(path),
                   "pointer projection bounded original family path");
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    profileRequire(fd >= 0 && fstat(fd, &actual) == 0, "pointer projection actual enrollment descriptor");
    expected.mainDevice[family] = actual.st_dev; expected.mainInode[family] = actual.st_ino;
    profileRequire(close(fd) == 0, "pointer projection enrollment descriptor drained");
  }
  profileRequire(brc38ProfileQuotaInitialize(&driverQuota, root, 4194304, &expected) == SQLITE_OK &&
                 driverQuota.mainMaximum[0] == 330 * 4096,
                 "pointer projection unchanged exact page formula");

  driverFamily = 0;
  profileRequire(openNative(0, 0) == SQLITE_OK && controlSql(driverDb[0],
    "CREATE TABLE independent_local_coordinates(tableId,oldRowId,newRowId,present);"
    "CREATE VIEW brc38_local_baseline_event(tableId,oldRowId,newRowId,present) AS SELECT NULL,NULL,NULL,NULL WHERE 0;"
    "CREATE TRIGGER independent_pointer_dispatch INSTEAD OF INSERT ON brc38_local_baseline_event BEGIN "
    "INSERT INTO independent_local_coordinates VALUES(NEW.tableId,NEW.oldRowId,NEW.newRowId,NEW.present); END;"
    "CREATE TABLE brc38_native_binary_fields(tableId,rowId);"
    "CREATE TABLE brc38_native_text_fields(tableId,rowId)") == SQLITE_OK,
    "pointer projection actual independent rowless coordinate fixture");
  static const struct { const char *family, *table, *key; int id, coordinate; } cases[] = {
    {"binary","transactions","transactionId",0,7}, {"binary","proven_txs","provenTxId",1,2},
    {"binary","proven_tx_reqs","provenTxReqId",2,3}, {"binary","outputs","outputId",3,8},
    {"binary","commissions","commissionId",4,9}, {"binary","prepared_beefs","preparedBeefId",8,17},
    {"binary","action_batch_blobs","actionBatchBlobId",9,20}, {"binary","sync_transfer_parts","rowid",10,22},
    {"binary","snapshot_reconciliation_stage_pages","rowid",14,31},
    {"binary","snapshot_reconciliation_provenance","rowid",15,45},
    {"text","transactions","transactionId",0,7}, {"text","proven_tx_reqs","provenTxReqId",2,3},
    {"text","outputs","outputId",3,8}, {"text","commissions","commissionId",4,9},
    {"text","sync_states","syncStateId",5,14}, {"text","certificates","certificateId",6,12},
    {"text","certificate_fields","rowid",7,13}, {"text","action_batches","actionBatchId",11,18},
    {"text","sync_transfers","slot",12,21}, {"text","monitor_events","id",13,15}
  };
  for (size_t point = 0; point < sizeof(cases) / sizeof(cases[0]); point++) {
    const char *family = cases[point].family, *table = cases[point].table, *key = cases[point].key;
    int physical = !strcmp(key, "rowid"); char sql[2048], name[192], canonical[1024];
    int amount = physical
      ? snprintf(sql, sizeof(sql), "CREATE TABLE %s(value);INSERT INTO %s(rowid,value) VALUES(-5,1)", table, table)
      : snprintf(sql, sizeof(sql), "CREATE TABLE %s(%s INTEGER UNIQUE);INSERT INTO %s(rowid,%s) VALUES(-5,42)", table, key, table, key);
    profileRequire(amount > 0 && amount < (int)sizeof(sql) && controlSql(driverDb[0], sql) == SQLITE_OK,
                   "pointer projection independently created actual parent");
    for (int event = 0; event < 2; event++) {
      const char *context = event == 0 ? "NEW" : "OLD", *operation = event == 0 ? "INSERT" : "DELETE";
      amount = snprintf(name, sizeof(name), "brc38_local_baseline_packed_%s_%d_%s", family, cases[point].id, operation);
      profileRequire(amount > 0 && amount < (int)sizeof(name), "pointer projection bounded independent trigger name");
      amount = snprintf(canonical, sizeof(canonical),
        "CREATE TRIGGER %s AFTER %s ON brc38_native_%s_fields WHEN %s.tableId=%d "
        "BEGIN INSERT INTO brc38_local_baseline_event SELECT %d,NULL,s.rowid,1 "
        "FROM %s s WHERE s.%s=%s.rowId LIMIT 1; END",
        name, operation, family, context, cases[point].id, cases[point].coordinate, table, key, context);
      profileRequire(amount > 0 && amount < (int)sizeof(canonical) && controlSql(driverDb[0], canonical) == SQLITE_OK,
                     "pointer projection independent canonical emitter installed");
      int reference = physical ? -5 : 42;
      amount = snprintf(sql, sizeof(sql), event == 0
        ? "INSERT INTO brc38_native_%s_fields VALUES(%d,%d)"
        : "DELETE FROM brc38_native_%s_fields WHERE tableId=%d AND rowId=%d", family, cases[point].id, reference);
      profileRequire(amount > 0 && amount < (int)sizeof(sql) && sqlite3_exec(driverDb[0], sql, NULL, NULL, NULL) == SQLITE_OK,
                     "pointer projection actual pointer transition accepted");
      amount = snprintf(sql, sizeof(sql), "SELECT count(*) FROM independent_local_coordinates WHERE tableId=%d AND oldRowId IS NULL AND newRowId=-5 AND present=1", cases[point].coordinate);
      profileRequire(amount > 0 && amount < (int)sizeof(sql) && localObserverValue(sql) == event + 1,
                     "pointer projection original physical coordinate and transition count");
    }
    amount = snprintf(sql, sizeof(sql), "SAVEPOINT independent_pointer_rollback;INSERT INTO brc38_native_%s_fields VALUES(%d,%d);ROLLBACK TO independent_pointer_rollback;RELEASE independent_pointer_rollback", family, cases[point].id, physical ? -5 : 42);
    profileRequire(amount > 0 && amount < (int)sizeof(sql) && sqlite3_exec(driverDb[0], sql, NULL, NULL, NULL) == SQLITE_OK &&
                   localObserverValue("SELECT count(*) FROM independent_local_coordinates") == 2,
                   "pointer projection pointer and coordinate physically roll back together");
    amount = snprintf(sql, sizeof(sql), "INSERT INTO brc38_native_%s_fields VALUES(%d,404)", family, cases[point].id);
    profileRequire(amount > 0 && amount < (int)sizeof(sql) && sqlite3_exec(driverDb[0], sql, NULL, NULL, NULL) == SQLITE_OK &&
                   localObserverValue("SELECT count(*) FROM independent_local_coordinates") == 2,
                   "pointer projection absent parent emits no fabricated coordinate");
    profileRequire(sqlite3_exec(driverDb[0], "INSERT INTO brc38_local_baseline_event VALUES(7,NULL,-5,1)", NULL, NULL, NULL) == SQLITE_AUTH,
                   "pointer projection direct dispatch remains unauthorized");
    amount = snprintf(sql, sizeof(sql), "CREATE TEMP TRIGGER brc38_local_baseline_packed_%s_%d_INSERT AFTER INSERT ON main.brc38_native_%s_fields BEGIN SELECT 1; END", family, cases[point].id, family);
    profileRequire(amount > 0 && amount < (int)sizeof(sql) && controlSql(driverDb[0], sql) == SQLITE_OK,
                   "pointer projection owned temporary shadow installed");
    amount = snprintf(sql, sizeof(sql), "INSERT INTO brc38_native_%s_fields VALUES(%d,%d)", family, cases[point].id, physical ? -5 : 42);
    profileRequire(amount > 0 && amount < (int)sizeof(sql) && sqlite3_exec(driverDb[0], sql, NULL, NULL, NULL) == SQLITE_AUTH &&
                   localObserverValue("SELECT count(*) FROM independent_local_coordinates") == 2,
                   "pointer projection freshly checked temporary shadow refuses source mutation");
    amount = snprintf(sql, sizeof(sql), "DROP TRIGGER temp.brc38_local_baseline_packed_%s_%d_INSERT;DROP TRIGGER brc38_local_baseline_packed_%s_%d_INSERT;DROP TRIGGER brc38_local_baseline_packed_%s_%d_DELETE;DELETE FROM brc38_native_%s_fields;DELETE FROM independent_local_coordinates;DROP TABLE %s", family, cases[point].id, family, cases[point].id, family, cases[point].id, family, table);
    profileRequire(amount > 0 && amount < (int)sizeof(sql) && controlSql(driverDb[0], sql) == SQLITE_OK,
                   "pointer projection independent source and observers retired");
  }
  profileRequire(closeNative(0) == SQLITE_OK && brc38QuotaClose(&driverQuota) == SQLITE_OK,
                 "pointer projection database and VFS physically drained");
  profileRemove(root);
  profileRequire(sqlite3_memory_highwater(0) <= 4194304 && sqlite3_shutdown() == SQLITE_OK,
                 "pointer projection original heap ceiling and SQLite shutdown");
  printf("PASS independent pointer projection coordinates=20 transitions=40 checks=%d fixturesDrained=true\n", profileChecks);
  return 0;
}
