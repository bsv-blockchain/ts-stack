/* Additive actual-kernel dispatch contract. The independent row/charge oracle
 * is intentionally fixed here, separately from the generated installation SQL.
 * This component does not replace the original six native components. */
static sqlite3_int64 quotaContractScalar(const char *text) {
  sqlite3_stmt *statement = NULL;
  profileRequire(sqlite3_prepare_v2(driverDb[0], text, -1, &statement, NULL) == SQLITE_OK,
                 "quota independent observation prepared");
  profileRequire(sqlite3_step(statement) == SQLITE_ROW, "quota independent observation row");
  sqlite3_int64 value = sqlite3_column_int64(statement, 0);
  profileRequire(sqlite3_step(statement) == SQLITE_DONE && sqlite3_finalize(statement) == SQLITE_OK,
                 "quota independent observation physically drained");
  return value;
}
static void quotaContractState(sqlite3_int64 bytes, sqlite3_int64 rows) {
  profileRequire(quotaContractScalar("SELECT bytes FROM snapshot_reconciliation_shared_quota WHERE id=0") == bytes &&
                 quotaContractScalar("SELECT rows FROM snapshot_reconciliation_shared_quota WHERE id=0") == rows &&
                 quotaContractScalar("SELECT count(*) FROM snapshot_reconciliation_identity_budgets") == rows &&
                 quotaContractScalar("SELECT count(*) FROM snapshot_reconciliation_quota_event") == 0,
                 "quota actual counter, independent parent rows and rowless dispatch agree");
}
static int sharedQuotaContracts(void) {
  const char *root = "/work/shared-quota-contract";
  profileRequire(brc38NativeRuntimeInitialize(67108864, 4194304, 32) == SQLITE_OK,
                 "quota original runtime resource ceilings");
  profileRequire(mkdir(root, 0700) == 0, "quota fixture owns private directory");
  Brc38ProfileEnrollment expected = {0}; struct stat actual;
  profileRequire(lstat(root, &actual) == 0, "quota actual directory identity");
  expected.directoryDevice = actual.st_dev; expected.directoryInode = actual.st_ino;
  for (int family = 0; family < 3; family++) {
    char path[PATH_MAX];
    profileRequire(snprintf(path, sizeof(path), "%s/%s", root, brc38Names[family * 4]) < (int)sizeof(path),
                   "quota bounded original family path");
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    profileRequire(fd >= 0 && fstat(fd, &actual) == 0, "quota actual preparatory descriptor");
    expected.mainDevice[family] = actual.st_dev; expected.mainInode[family] = actual.st_ino;
    profileRequire(close(fd) == 0, "quota preparatory descriptor drained");
  }
  profileRequire(brc38ProfileQuotaInitialize(&driverQuota, root, 4194304, &expected) == SQLITE_OK &&
                 driverQuota.mainMaximum[0] == 330 * 4096,
                 "quota original profile aggregate and exact profile page formula");
  driverFamily = 0;
  profileRequire(openNative(0, 0) == SQLITE_OK, "quota actual guarded kernel opened");
  profileRequire(quotaContractScalar("SELECT brc38_shared_quota_event_protocol()='brc38-shared-quota-event/v1'") == 1,
                 "quota fresh actual kernel protocol");
  profileRequire(controlSql(driverDb[0],
    "CREATE TABLE snapshot_reconciliation_shared_quota(id INTEGER PRIMARY KEY,byteLimit INTEGER,rowLimit INTEGER,bytes INTEGER,rows INTEGER,changeBit INTEGER);"
    "INSERT INTO snapshot_reconciliation_shared_quota VALUES(0,17179869184,2147483647,0,0,0)") == SQLITE_OK,
    "quota independent fixed counter fixture");
  for (size_t i = 0; i < sizeof(brc38QuotaSources)/sizeof(brc38QuotaSources[0]); i++)
    profileRequire(controlSql(driverDb[0], brc38QuotaSources[i].sql) == SQLITE_OK, "quota complete original parent inventory");
  for (size_t i = 0; i < 2; i++)
    profileRequire(controlSql(driverDb[0], brc38QuotaDispatchDefinitions[i]) == SQLITE_OK, "quota exact dispatch definitions");
  for (size_t i = 0; i < sizeof(brc38QuotaEmitters)/sizeof(brc38QuotaEmitters[0]); i++)
    profileRequire(controlSql(driverDb[0], brc38QuotaEmitters[i].sql) == SQLITE_OK, "quota complete original emitter inventory");
  profileRequire(quotaContractScalar("SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name LIKE 'snapshot_reconciliation_quota_%'") == 55,
                 "quota all54 original emitters and one consumer installed");
  const char *insert = "INSERT INTO snapshot_reconciliation_identity_budgets VALUES(12,'é😀',9,0)";
  profileRequire(sqlite3_exec(driverDb[0], insert, NULL, NULL, NULL) == SQLITE_OK, "quota actual guarded insert");
  /* 4096 +4*(UTF8('12')=2 +UTF8('é😀')=6 +'9'=1 +'0'=1). */
  quotaContractState(4136, 1);
  profileRequire(sqlite3_exec(driverDb[0],
    "INSERT INTO snapshot_reconciliation_identity_budgets VALUES(12,'é😀',10,1) ON CONFLICT(userId,lineage) DO UPDATE SET maximumMappings=excluded.maximumMappings,mappings=excluded.mappings",
    NULL, NULL, NULL) == SQLITE_OK, "quota actual conflict update");
  quotaContractState(4140, 1);
  driverFamily = 1;
  profileRequire(sqlite3_exec(driverDb[0], "UPDATE snapshot_reconciliation_identity_budgets SET mappings=2", NULL, NULL, NULL) == SQLITE_AUTH,
                 "quota foreign family cannot dispatch");
  driverFamily = 0;
  quotaContractState(4140, 1);
  profileRequire(controlSql(driverDb[0],
    "CREATE TEMP TRIGGER snapshot_reconciliation_quota_identity_budgets_update AFTER UPDATE ON main.snapshot_reconciliation_identity_budgets BEGIN SELECT 1; END") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "UPDATE snapshot_reconciliation_identity_budgets SET mappings=2", NULL, NULL, NULL) == SQLITE_AUTH,
    "quota temporary emitter-name shadow refused");
  quotaContractState(4140, 1);
  profileRequire(controlSql(driverDb[0], "DROP TRIGGER temp.snapshot_reconciliation_quota_identity_budgets_update") == SQLITE_OK,
                 "quota temporary source drained");
  profileRequire(sqlite3_exec(driverDb[0],
    "SAVEPOINT quota_rollback; UPDATE snapshot_reconciliation_identity_budgets SET mappings=100; ROLLBACK TO quota_rollback; RELEASE quota_rollback",
    NULL, NULL, NULL) == SQLITE_OK, "quota row and counter savepoint rollback");
  quotaContractState(4140, 1);
  profileRequire(sqlite3_exec(driverDb[0], "INSERT INTO snapshot_reconciliation_quota_event VALUES(0,4096,1)",
    NULL, NULL, NULL) == SQLITE_AUTH, "quota direct dispatch refused");
  quotaContractState(4140, 1);
  /* Fresh complete-definition checks must reject harmless source drift too. */
  profileRequire(controlSql(driverDb[0], "DROP TRIGGER snapshot_reconciliation_quota_identity_budgets_update") == SQLITE_OK,
                 "quota source drift fixture owns removal");
  profileRequire(controlSql(driverDb[0],
    "CREATE TRIGGER snapshot_reconciliation_quota_identity_budgets_update AFTER UPDATE ON snapshot_reconciliation_identity_budgets BEGIN INSERT INTO snapshot_reconciliation_quota_event VALUES(0,0,0); END") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "UPDATE snapshot_reconciliation_identity_budgets SET mappings=2", NULL, NULL, NULL) == SQLITE_AUTH,
    "quota changed complete emitter refused freshly");
  quotaContractState(4140, 1);
  profileRequire(controlSql(driverDb[0], "DROP TRIGGER snapshot_reconciliation_quota_identity_budgets_update") == SQLITE_OK,
                 "quota altered source removed");
  for (size_t i = 0; i < sizeof(brc38QuotaEmitters)/sizeof(brc38QuotaEmitters[0]); i++)
    if (!strcmp(brc38QuotaEmitters[i].name, "snapshot_reconciliation_quota_identity_budgets_update"))
      profileRequire(controlSql(driverDb[0], brc38QuotaEmitters[i].sql) == SQLITE_OK, "quota exact emitter restored");
  profileRequire(controlSql(driverDb[0], "DROP TRIGGER snapshot_reconciliation_quota_event_apply") == SQLITE_OK &&
    controlSql(driverDb[0], "CREATE TRIGGER snapshot_reconciliation_quota_event_apply INSTEAD OF INSERT ON snapshot_reconciliation_quota_event BEGIN SELECT 1; END") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "UPDATE snapshot_reconciliation_identity_budgets SET mappings=2", NULL, NULL, NULL) == SQLITE_AUTH,
    "quota changed complete consumer refused freshly");
  quotaContractState(4140, 1);
  profileRequire(controlSql(driverDb[0], "DROP TRIGGER snapshot_reconciliation_quota_event_apply") == SQLITE_OK &&
    controlSql(driverDb[0], brc38QuotaDispatchDefinitions[1]) == SQLITE_OK,
    "quota exact consumer restored");
  profileRequire(controlSql(driverDb[0], "DROP TRIGGER snapshot_reconciliation_quota_event_apply; DROP VIEW snapshot_reconciliation_quota_event") == SQLITE_OK &&
    controlSql(driverDb[0], "CREATE VIEW snapshot_reconciliation_quota_event AS SELECT 1 AS beforeBytes,0 AS afterBytes,0 AS rowDelta WHERE 0") == SQLITE_OK &&
    controlSql(driverDb[0], brc38QuotaDispatchDefinitions[1]) == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "UPDATE snapshot_reconciliation_identity_budgets SET mappings=2", NULL, NULL, NULL) == SQLITE_AUTH,
    "quota changed complete view refused freshly");
  quotaContractState(4140, 1);
  profileRequire(controlSql(driverDb[0], "DROP TRIGGER snapshot_reconciliation_quota_event_apply; DROP VIEW snapshot_reconciliation_quota_event") == SQLITE_OK &&
    controlSql(driverDb[0], brc38QuotaDispatchDefinitions[0]) == SQLITE_OK &&
    controlSql(driverDb[0], brc38QuotaDispatchDefinitions[1]) == SQLITE_OK,
    "quota exact view and consumer restored");
  profileRequire(sqlite3_exec(driverDb[0], "DELETE FROM snapshot_reconciliation_identity_budgets", NULL, NULL, NULL) == SQLITE_OK,
                 "quota actual guarded deletion");
  quotaContractState(0, 0);
  profileRequire(controlSql(driverDb[0], "UPDATE snapshot_reconciliation_shared_quota SET bytes=17179869184") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], insert, NULL, NULL, NULL) == SQLITE_CONSTRAINT_TRIGGER,
    "quota unchanged byte ceiling aborts actual parent insert");
  quotaContractState(INT64_C(17179869184), 0);
  profileRequire(controlSql(driverDb[0], "UPDATE snapshot_reconciliation_shared_quota SET bytes=0") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], insert, NULL, NULL, NULL) == SQLITE_OK &&
    controlSql(driverDb[0], "UPDATE snapshot_reconciliation_shared_quota SET bytes=0") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "DELETE FROM snapshot_reconciliation_identity_budgets", NULL, NULL, NULL) == SQLITE_CONSTRAINT_TRIGGER,
    "quota inconsistent underflow preserves actual parent row");
  quotaContractState(0, 1);
  profileRequire(controlSql(driverDb[0], "DELETE FROM snapshot_reconciliation_shared_quota") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "UPDATE snapshot_reconciliation_identity_budgets SET mappings=2", NULL, NULL, NULL) == SQLITE_CONSTRAINT_TRIGGER &&
    quotaContractScalar("SELECT mappings FROM snapshot_reconciliation_identity_budgets") == 0,
    "quota missing counter aborts actual parent change");
  profileRequire(controlSql(driverDb[0], "ALTER TABLE snapshot_reconciliation_identity_budgets ADD COLUMN benign INTEGER") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "UPDATE snapshot_reconciliation_identity_budgets SET mappings=2", NULL, NULL, NULL) == SQLITE_AUTH &&
    quotaContractScalar("SELECT mappings FROM snapshot_reconciliation_identity_budgets") == 0,
    "quota changed complete parent refused freshly without changing its row");
  profileRequire(closeNative(0) == SQLITE_OK && brc38QuotaClose(&driverQuota) == SQLITE_OK,
                 "quota actual database/VFS physically drained");
  profileRemove(root);
  profileRequire(sqlite3_memory_highwater(0) <= 4194304 && sqlite3_shutdown() == SQLITE_OK,
                 "quota original heap and physical SQLite shutdown");
  printf("PASS shared-quota dispatch independent guards and rollback checks=%d\n", profileChecks);
  return 0;
}
