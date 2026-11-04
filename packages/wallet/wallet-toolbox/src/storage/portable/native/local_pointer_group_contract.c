/* Independent physical transport oracle. Every original component is retained.
 * This checks grouped coordinate effects and authorization, not wallet scope or
 * combined capacity qualification. */
static int localPointerGroupContracts(void) {
  const char *root = "/work/local-pointer-group-contract";
  profileRequire(brc38NativeRuntimeInitialize(67108864, 4194304, 32) == SQLITE_OK,
                 "pointer group unchanged runtime ceilings");
  profileRequire(mkdir(root, 0700) == 0, "pointer group private fixture directory");
  Brc38ProfileEnrollment expected = {0}; struct stat actual;
  profileRequire(lstat(root, &actual) == 0, "pointer group actual directory");
  expected.directoryDevice = actual.st_dev; expected.directoryInode = actual.st_ino;
  for (int family = 0; family < 3; family++) {
    char path[PATH_MAX];
    profileRequire(snprintf(path, sizeof(path), "%s/%s", root, brc38Names[family * 4]) < (int)sizeof(path), "pointer group family path");
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    profileRequire(fd >= 0 && fstat(fd, &actual) == 0, "pointer group enrollment descriptor");
    expected.mainDevice[family] = actual.st_dev; expected.mainInode[family] = actual.st_ino;
    profileRequire(close(fd) == 0, "pointer group enrollment drained");
  }
  profileRequire(brc38ProfileQuotaInitialize(&driverQuota, root, 4194304, &expected) == SQLITE_OK && driverQuota.mainMaximum[0] == 330 * 4096, "pointer group page formula retained");
  driverFamily = 0;
  profileRequire(openNative(0, 0) == SQLITE_OK && controlSql(driverDb[0],
    "CREATE TABLE independent_group_coordinates(tableId,oldRowId,newRowId,present);"
    "CREATE VIEW brc38_local_baseline_event(tableId,oldRowId,newRowId,present) AS SELECT NULL,NULL,NULL,NULL WHERE 0;"
    "CREATE TRIGGER independent_group_dispatch INSTEAD OF INSERT ON brc38_local_baseline_event BEGIN INSERT INTO independent_group_coordinates VALUES(NEW.tableId,NEW.oldRowId,NEW.newRowId,NEW.present); END;"
    "CREATE TABLE brc38_native_binary_fields(tableId,rowId);CREATE TABLE brc38_native_text_fields(tableId,rowId)") == SQLITE_OK, "pointer group independent physical fixture");
  static const struct { const char *family, *table, *key; int id, coordinate; } cases[] = {
    {"binary","transactions","transactionId",0,7}, {"binary","proven_txs","provenTxId",1,2},
    {"binary","proven_tx_reqs","provenTxReqId",2,3}, {"binary","outputs","outputId",3,8},
    {"binary","commissions","commissionId",4,9}, {"binary","prepared_beefs","preparedBeefId",8,17},
    {"binary","action_batch_blobs","actionBatchBlobId",9,20}, {"binary","sync_transfer_parts","rowid",10,22},
    {"binary","snapshot_reconciliation_stage_pages","rowid",14,31}, {"binary","snapshot_reconciliation_provenance","rowid",15,45},
    {"text","transactions","transactionId",0,7}, {"text","proven_tx_reqs","provenTxReqId",2,3},
    {"text","outputs","outputId",3,8}, {"text","commissions","commissionId",4,9},
    {"text","sync_states","syncStateId",5,14}, {"text","certificates","certificateId",6,12},
    {"text","certificate_fields","rowid",7,13}, {"text","action_batches","actionBatchId",11,18},
    {"text","sync_transfers","slot",12,21}, {"text","monitor_events","id",13,15}
  };
  for (size_t point = 0; point < sizeof(cases) / sizeof(cases[0]); point++) {
    int duplicate = 0;
    for (size_t prior = 0; prior < point; prior++) duplicate |= !strcmp(cases[prior].table, cases[point].table);
    if (duplicate) continue;
    char sql[512]; int amount = !strcmp(cases[point].key, "rowid")
      ? snprintf(sql, sizeof(sql), "CREATE TABLE %s(value);INSERT INTO %s(rowid,value) VALUES(-5,1)", cases[point].table, cases[point].table)
      : snprintf(sql, sizeof(sql), "CREATE TABLE %s(%s INTEGER UNIQUE);INSERT INTO %s(rowid,%s) VALUES(-5,42)", cases[point].table, cases[point].key, cases[point].table, cases[point].key);
    profileRequire(amount > 0 && amount < (int)sizeof(sql) && controlSql(driverDb[0], sql) == SQLITE_OK, "pointer group actual parent distinct physical key");
  }
  int coordinates = 0, transitions = 0;
  for (int local = 0; local < 2; local++) {
    char binaryInsert[1536];
    for (int family = 0; family < 2; family++) for (int event = 0; event < 2; event++) {
      const char *kind = family ? "text" : "binary", *context = event ? "OLD" : "NEW", *operation = event ? "DELETE" : "INSERT";
      char canonical[1536]; int amount = snprintf(canonical, sizeof(canonical), "CREATE TRIGGER brc38_local_baseline_packed_%s_%s AFTER %s ON brc38_native_%s_fields BEGIN INSERT INTO brc38_local_baseline_event ", kind, operation, operation, kind);
      profileRequire(amount > 0 && amount < (int)sizeof(canonical), "pointer group bounded independent header");
      size_t used = (size_t)amount; int branches = 0;
      for (size_t point = 0; point < sizeof(cases) / sizeof(cases[0]); point++) {
        if (strcmp(cases[point].family, kind) || (!local && cases[point].id >= 8)) continue;
        amount = snprintf(canonical + used, sizeof(canonical) - used, "%sSELECT %d,NULL,s.rowid,1 FROM %s s WHERE %s.tableId=%d AND s.%s=%s.rowId", branches++ ? " UNION ALL " : "", cases[point].coordinate, cases[point].table, context, cases[point].id, cases[point].key, context);
        profileRequire(amount > 0 && amount < (int)(sizeof(canonical) - used), "pointer group bounded independent point"); used += (size_t)amount;
      }
      amount = snprintf(canonical + used, sizeof(canonical) - used, " LIMIT 1; END");
      profileRequire(amount > 0 && amount < (int)(sizeof(canonical) - used) && controlSql(driverDb[0], canonical) == SQLITE_OK, "pointer group complete independent emitter");
      if (family == 0 && event == 0) memcpy(binaryInsert, canonical, strlen(canonical) + 1);
    }
    for (size_t point = 0; point < sizeof(cases) / sizeof(cases[0]); point++) {
      const char *kind = cases[point].family; int reference = !strcmp(cases[point].key, "rowid") ? -5 : 42;
      char sql[1024]; int amount;
      if (!local && cases[point].id >= 8) {
        amount = snprintf(sql, sizeof(sql), "INSERT INTO brc38_native_%s_fields VALUES(%d,%d);DELETE FROM brc38_native_%s_fields", kind, cases[point].id, reference, kind);
        profileRequire(amount > 0 && amount < (int)sizeof(sql) && sqlite3_exec(driverDb[0], sql, NULL, NULL, NULL) == SQLITE_OK && localObserverValue("SELECT count(*) FROM independent_group_coordinates") == 0, "pointer group base leaves local coordinates unobserved");
        continue;
      }
      coordinates++;
      for (int event = 0; event < 2; event++) {
        amount = snprintf(sql, sizeof(sql), event ? "DELETE FROM brc38_native_%s_fields WHERE tableId=%d AND rowId=%d" : "INSERT INTO brc38_native_%s_fields VALUES(%d,%d)", kind, cases[point].id, reference);
        profileRequire(amount > 0 && amount < (int)sizeof(sql) && sqlite3_exec(driverDb[0], sql, NULL, NULL, NULL) == SQLITE_OK, "pointer group original pointer transition"); transitions++;
        amount = snprintf(sql, sizeof(sql), "SELECT count(*) FROM independent_group_coordinates WHERE tableId=%d AND oldRowId IS NULL AND newRowId=-5 AND present=1", cases[point].coordinate);
        profileRequire(amount > 0 && amount < (int)sizeof(sql) && localObserverValue(sql) == event + 1, "pointer group exact physical coordinate and count");
      }
      amount = snprintf(sql, sizeof(sql), "SAVEPOINT independent_group_rollback;INSERT INTO brc38_native_%s_fields VALUES(%d,%d);ROLLBACK TO independent_group_rollback;RELEASE independent_group_rollback", kind, cases[point].id, reference);
      profileRequire(amount > 0 && amount < (int)sizeof(sql) && sqlite3_exec(driverDb[0], sql, NULL, NULL, NULL) == SQLITE_OK && localObserverValue("SELECT count(*) FROM independent_group_coordinates") == 2, "pointer group atomic rollback");
      amount = snprintf(sql, sizeof(sql), "INSERT INTO brc38_native_%s_fields VALUES(%d,404)", kind, cases[point].id);
      profileRequire(amount > 0 && amount < (int)sizeof(sql) && sqlite3_exec(driverDb[0], sql, NULL, NULL, NULL) == SQLITE_OK && localObserverValue("SELECT count(*) FROM independent_group_coordinates") == 2, "pointer group absent parent emits nothing");
      profileRequire(sqlite3_exec(driverDb[0], "INSERT INTO brc38_local_baseline_event VALUES(7,NULL,-5,1)", NULL, NULL, NULL) == SQLITE_AUTH, "pointer group direct dispatch refused");
      amount = snprintf(sql, sizeof(sql), "CREATE TEMP TRIGGER brc38_local_baseline_packed_%s_INSERT AFTER INSERT ON main.brc38_native_%s_fields BEGIN SELECT 1; END", kind, kind);
      profileRequire(amount > 0 && amount < (int)sizeof(sql) && controlSql(driverDb[0], sql) == SQLITE_OK, "pointer group temporary shadow");
      amount = snprintf(sql, sizeof(sql), "INSERT INTO brc38_native_%s_fields VALUES(%d,%d)", kind, cases[point].id, reference);
      profileRequire(amount > 0 && amount < (int)sizeof(sql) && sqlite3_exec(driverDb[0], sql, NULL, NULL, NULL) == SQLITE_AUTH && localObserverValue("SELECT count(*) FROM independent_group_coordinates") == 2, "pointer group fresh shadow refusal");
      amount = snprintf(sql, sizeof(sql), "DROP TRIGGER temp.brc38_local_baseline_packed_%s_INSERT;DELETE FROM brc38_native_%s_fields;DELETE FROM independent_group_coordinates", kind, kind);
      profileRequire(amount > 0 && amount < (int)sizeof(sql) && controlSql(driverDb[0], sql) == SQLITE_OK, "pointer group point fixture reset");
    }
    profileRequire(controlSql(driverDb[0], "DROP TRIGGER brc38_local_baseline_packed_binary_INSERT;CREATE TRIGGER brc38_local_baseline_packed_binary_INSERT AFTER INSERT ON brc38_native_binary_fields BEGIN INSERT INTO brc38_local_baseline_event VALUES(999,NULL,0,1); END") == SQLITE_OK, "pointer group altered source fixture");
    profileRequire(sqlite3_exec(driverDb[0], "INSERT INTO brc38_native_binary_fields VALUES(0,42)", NULL, NULL, NULL) == SQLITE_AUTH && localObserverValue("SELECT count(*) FROM independent_group_coordinates") == 0 && localObserverValue("SELECT count(*) FROM brc38_native_binary_fields") == 0, "pointer group altered observer refuses without pointer effect");
    profileRequire(controlSql(driverDb[0], "DROP TRIGGER brc38_local_baseline_packed_binary_INSERT") == SQLITE_OK && controlSql(driverDb[0], binaryInsert) == SQLITE_OK, "pointer group exact source restored");
    driverRetiredRead = 1;
    profileRequire(sqlite3_exec(driverDb[0], "INSERT INTO brc38_native_binary_fields VALUES(0,42)", NULL, NULL, NULL) == SQLITE_AUTH, "pointer group retired actor refuses");
    driverRetiredRead = 0; driverCandidateComparison = 1;
    profileRequire(sqlite3_exec(driverDb[0], "INSERT INTO brc38_native_binary_fields VALUES(0,42)", NULL, NULL, NULL) == SQLITE_AUTH, "pointer group comparison actor refuses");
    driverCandidateComparison = 0;
    profileRequire(controlSql(driverDb[0], "DROP TRIGGER brc38_local_baseline_packed_binary_INSERT;DROP TRIGGER brc38_local_baseline_packed_binary_DELETE;DROP TRIGGER brc38_local_baseline_packed_text_INSERT;DROP TRIGGER brc38_local_baseline_packed_text_DELETE") == SQLITE_OK, "pointer group family retired");
  }
  profileRequire(coordinates == 32 && transitions == 64, "pointer group full and base independent coverage");
  profileRequire(closeNative(0) == SQLITE_OK && brc38QuotaClose(&driverQuota) == SQLITE_OK, "pointer group physical kernel/VFS drain");
  profileRemove(root);
  profileRequire(sqlite3_memory_highwater(0) <= 4194304 && sqlite3_shutdown() == SQLITE_OK, "pointer group original heap and shutdown");
  printf("PASS independent grouped pointers coordinates=32 transitions=64 checks=%d fixturesDrained=true\n", profileChecks);
  return 0;
}
