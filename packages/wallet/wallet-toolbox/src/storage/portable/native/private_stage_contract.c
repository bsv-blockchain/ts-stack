/* Additive synthetic native owner/VFS contract. No BRC39 authentication,
 * original semantic/property oracle, receiver activation or platform proof is
 * replaced by this finite fixture. Only the supervised Linux cohort may run it. */
static void recoveryStageContracts(void);
static void localEventAuthorizationContracts(void);
static int privateStageContracts(void) {
  const char *root = "/work/private-stage-contract";
  profileRequire(brc38NativeRuntimeInitialize(67108864, 4194304, 32) == SQLITE_OK,
                 "private stage fixed native runtime initialized");
  profileRequire(mkdir(root, 0700) == 0, "private stage fixture owns its directory");
  Brc38ProfileEnrollment expected = {0};
  struct stat actual;
  profileRequire(lstat(root, &actual) == 0, "private stage actual directory identity");
  expected.directoryDevice = actual.st_dev; expected.directoryInode = actual.st_ino;
  const char *files[] = {"stage.sqlite", "brc38-owner.sqlite"};
  for (int family = 0; family < 2; family++) {
    char path[PATH_MAX];
    profileRequire(snprintf(path, sizeof(path), "%s/%s", root, files[family]) < (int)sizeof(path),
                   "private stage fixed bounded path");
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    profileRequire(fd >= 0 && fstat(fd, &actual) == 0, "private stage actual main descriptor");
    expected.mainDevice[family] = actual.st_dev; expected.mainInode[family] = actual.st_ino;
    profileRequire(close(fd) == 0, "private stage preparatory descriptor drained");
  }
  sqlite3_vfs *original = sqlite3_vfs_find(NULL);
  Brc38Quota refused;
  Brc38ProfileEnrollment wrong = expected; wrong.mainInode[1]++;
  profileRequire(brc38StageQuotaInitialize(&refused, root, 1048576, &wrong) == SQLITE_CANTOPEN,
                 "private stage replaced owner inode refused");
  wrong = expected; wrong.mainInode[0]++;
  profileRequire(brc38StageQuotaInitialize(&refused, root, 1048576, &wrong) == SQLITE_CANTOPEN,
                 "private stage replaced source inode refused");
  wrong = expected; wrong.directoryInode++;
  profileRequire(brc38StageQuotaInitialize(&refused, root, 1048576, &wrong) == SQLITE_CANTOPEN,
                 "private stage replaced directory refused");
  profileRequire(brc38StageQuotaInitialize(&driverQuota, root, 1048576, &expected) == SQLITE_OK,
                 "private stage two actual families enrolled");
  profileRequire(driverQuota.families == 2 && driverQuota.maximum == 1048576 &&
                 driverQuota.mainMaximum[0] == 80 * 4096 && driverQuota.mainMaximum[1] == 4 * 4096 &&
                 driverQuota.shmMaximum == 0 && driverQuota.shmBudgets[0] == 0 &&
                 driverQuota.shmBudgets[1] == 0 && sqlite3_vfs_find(NULL) == original,
                 "private stage original page formula and DELETE-only aggregate unchanged");
  driverPrivateStage = 1;
  driverMaximum = 131072; driverDecodedMaximum = 196608;
  memset(driverStageBinding, 'a', 64); driverStageBinding[64] = 0;
  driverStageExpiry = privateStageWallMs() + 60000;
  driverStageDeadline = clockMs() + 60000;
  profileRequire(openNative(1, 0) == SQLITE_OK, "private stage native owner opened");
  profileRequire(controlSql(driverDb[1],
      "CREATE TABLE owner(slot INTEGER PRIMARY KEY,protocol TEXT,binding TEXT,expiresAt INTEGER);") == SQLITE_OK,
      "private stage synthetic owner schema");
  sqlite3_stmt *insert = NULL;
  profileRequire(sqlite3_prepare_v2(driverDb[1], "INSERT INTO owner VALUES(1,'brc38-private-owner/v1',?1,?2)",
      -1, &insert, NULL) == SQLITE_OK &&
      sqlite3_bind_text(insert, 1, driverStageBinding, 64, SQLITE_STATIC) == SQLITE_OK &&
      sqlite3_bind_int64(insert, 2, (sqlite3_int64)driverStageExpiry) == SQLITE_OK &&
      sqlite3_step(insert) == SQLITE_DONE && sqlite3_finalize(insert) == SQLITE_OK,
      "private stage original owner metadata inserted");
  profileRequire(privateStageCheck() == SQLITE_AUTH, "private stage no owner lock cannot admit");
  profileRequire(controlSql(driverDb[1], "BEGIN IMMEDIATE;") == SQLITE_OK && privateStageCheck() == SQLITE_OK,
                 "private stage actual write lock retained across source commits");
  sqlite3 *competing = NULL;
  char ownerPath[PATH_MAX];
  profileRequire(snprintf(ownerPath, sizeof(ownerPath), "%s/brc38-owner.sqlite", root) < (int)sizeof(ownerPath),
                 "private stage competing path bounded");
  profileRequire(sqlite3_open_v2(ownerPath, &competing, SQLITE_OPEN_READWRITE, driverQuota.vfs.zName) == SQLITE_OK,
                 "private stage independent competing connection opened");
  profileRequire(sqlite3_exec(competing, "BEGIN IMMEDIATE;", NULL, NULL, NULL) == SQLITE_BUSY,
                 "private stage actual competing writer refused by kernel");
  profileRequire(sqlite3_close(competing) == SQLITE_OK, "private stage competing connection drained");
  driverStageBinding[0] = 'b';
  profileRequire(privateStageCheck() == SQLITE_AUTH, "private stage wrong binding refused under real lock");
  driverStageBinding[0] = 'a';
  uint64_t deadline = driverStageDeadline; driverStageDeadline = clockMs();
  profileRequire(privateStageCheck() == SQLITE_AUTH, "private stage immutable monotonic expiry refused");
  driverStageDeadline = deadline;
  profileRequire(openNative(0, 0) == SQLITE_OK && openNative(2, 0) == SQLITE_MISUSE,
                 "private stage source opened without a catalog family");
  profileRequire(controlSql(driverDb[0], "CREATE TABLE data(id INTEGER PRIMARY KEY,payload BLOB);") == SQLITE_OK,
                 "private stage quota fixture schema");
  localEventAuthorizationContracts();
  int rc = SQLITE_OK, writes = 0;
  while (writes < 128 && rc == SQLITE_OK) {
    rc = controlSql(driverDb[0], "INSERT INTO data(payload) VALUES(zeroblob(4096));");
    if (rc == SQLITE_OK) writes++;
  }
  profileRequire(rc == SQLITE_FULL && writes > 0 && writes < 128,
                 "private stage native growth refuses unchanged original page allowance");
  profileRequire(driverQuota.handles <= BRC38_MAX_HANDLES && brc38QuotaClose(&driverQuota) == SQLITE_BUSY,
                 "private stage VFS cannot outlive its actual native connections");
  profileRequire(closeNative(0) == SQLITE_OK && closeNative(1) == SQLITE_OK &&
                 brc38QuotaClose(&driverQuota) == SQLITE_OK,
                 "private stage native connections and VFS physically drained");
  for (int family = 0; family < 2; family++) {
    char path[PATH_MAX];
    profileRequire(snprintf(path, sizeof(path), "%s/%s", root, files[family]) < (int)sizeof(path) &&
                   unlink(path) == 0, "private stage exact main file cleanup");
  }
  profileRequire(rmdir(root) == 0, "private stage exact directory cleanup");
  recoveryStageContracts();
  profileRequire(sqlite3_shutdown() == SQLITE_OK, "private stage SQLite physically shut down");
  printf("private-stage owner/VFS checks=%d synthetic-only\n", profileChecks);
  return 0;
}

/* Independent minimal actual SQLite transport fixture. These checks qualify
 * event-source authorization only, not the full v3 SQL observer or wallet. */
static void localEventAuthorizationContracts(void) {
  const char *insert = "CREATE TRIGGER brc38_local_baseline_monitor_events_insert AFTER INSERT ON monitor_events BEGIN "
    "INSERT INTO brc38_local_baseline_event(tableId,oldRowId,newRowId,present) VALUES(15,NULL,NEW.rowid,1); END";
  int family = driverFamily;
  driverFamily = 0;
  profileRequire(controlSql(driverDb[0],
    "CREATE TABLE monitor_events(id INTEGER PRIMARY KEY);"
    "CREATE TABLE independent_local_events(tableId,oldRowId,newRowId,present);"
    "CREATE VIEW brc38_local_baseline_event(tableId,oldRowId,newRowId,present) AS SELECT NULL,NULL,NULL,NULL WHERE 0;"
    "CREATE TRIGGER independent_local_dispatch INSTEAD OF INSERT ON brc38_local_baseline_event BEGIN "
    "INSERT INTO independent_local_events VALUES(NEW.tableId,NEW.oldRowId,NEW.newRowId,NEW.present); END;") == SQLITE_OK,
    "v3 source authorization fixture is actual rowless SQLite view");
  profileRequire(sqlite3_exec(driverDb[0],
    "INSERT INTO brc38_local_baseline_event VALUES(15,NULL,1,1)", NULL, NULL, NULL) == SQLITE_AUTH,
    "direct SQL cannot manufacture a local event");
  profileRequire(controlSql(driverDb[0], insert) == SQLITE_OK &&
    controlSql(driverDb[0],
      "CREATE TRIGGER brc38_local_baseline_monitor_events_update AFTER UPDATE ON monitor_events BEGIN "
      "INSERT INTO brc38_local_baseline_event(tableId,oldRowId,newRowId,present) VALUES(15,OLD.rowid,NEW.rowid,1); END;") == SQLITE_OK &&
    controlSql(driverDb[0],
      "CREATE TRIGGER brc38_local_baseline_monitor_events_delete AFTER DELETE ON monitor_events BEGIN "
      "INSERT INTO brc38_local_baseline_event(tableId,oldRowId,newRowId,present) VALUES(15,OLD.rowid,NULL,0); END;") == SQLITE_OK,
    "independent canonical observer SQL installed");
  profileRequire(sqlite3_exec(driverDb[0], "INSERT INTO monitor_events VALUES(1);UPDATE monitor_events SET id=2;DELETE FROM monitor_events;",
    NULL, NULL, NULL) == SQLITE_OK, "fresh exact canonical source observers retain all physical transitions");
  sqlite3_stmt *actual = NULL;
  profileRequire(sqlite3_prepare_v2(driverDb[0],
    "SELECT tableId,oldRowId,newRowId,present FROM independent_local_events ORDER BY rowid", -1, &actual, NULL) == SQLITE_OK &&
    sqlite3_step(actual) == SQLITE_ROW && sqlite3_column_int(actual,0) == 15 &&
    sqlite3_column_type(actual,1) == SQLITE_NULL && sqlite3_column_int(actual,2) == 1 && sqlite3_column_int(actual,3) == 1 &&
    sqlite3_step(actual) == SQLITE_ROW && sqlite3_column_int(actual,0) == 15 &&
    sqlite3_column_int(actual,1) == 1 && sqlite3_column_int(actual,2) == 2 && sqlite3_column_int(actual,3) == 1 &&
    sqlite3_step(actual) == SQLITE_ROW && sqlite3_column_int(actual,0) == 15 &&
    sqlite3_column_int(actual,1) == 2 && sqlite3_column_type(actual,2) == SQLITE_NULL && sqlite3_column_int(actual,3) == 0 &&
    sqlite3_step(actual) == SQLITE_DONE && sqlite3_finalize(actual) == SQLITE_OK,
    "independent observed INSERT/move/DELETE coordinates and statement drain");
  profileRequire(controlSql(driverDb[0],
    "DROP TRIGGER brc38_local_baseline_monitor_events_insert;"
    "CREATE TRIGGER brc38_local_baseline_monitor_events_insert AFTER INSERT ON monitor_events BEGIN "
    "INSERT INTO brc38_local_baseline_event(tableId,oldRowId,newRowId,present) VALUES(14,NULL,NEW.rowid,1); END;") == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "INSERT INTO monitor_events VALUES(3)", NULL, NULL, NULL) == SQLITE_AUTH,
    "same name/table cannot authorize changed complete observer SQL");
  profileRequire(controlSql(driverDb[0], "DROP TRIGGER brc38_local_baseline_monitor_events_insert") == SQLITE_OK &&
    controlSql(driverDb[0], insert) == SQLITE_OK &&
    sqlite3_exec(driverDb[0], "SAVEPOINT independent_local_rollback;INSERT INTO monitor_events VALUES(3);"
      "ROLLBACK TO independent_local_rollback;RELEASE independent_local_rollback", NULL, NULL, NULL) == SQLITE_OK,
    "canonical source and shared event effects roll back together");
  profileRequire(sqlite3_prepare_v2(driverDb[0],
    "SELECT (SELECT count(*) FROM monitor_events),(SELECT count(*) FROM independent_local_events),"
    "(SELECT count(*) FROM brc38_local_baseline_event)", -1, &actual, NULL) == SQLITE_OK &&
    sqlite3_step(actual) == SQLITE_ROW && sqlite3_column_int(actual,0) == 0 && sqlite3_column_int(actual,1) == 3 &&
    sqlite3_column_int(actual,2) == 0 && sqlite3_step(actual) == SQLITE_DONE && sqlite3_finalize(actual) == SQLITE_OK,
    "counterfeit write and rollback retain source absence, exact events and rowless view");
  profileRequire(controlSql(driverDb[0],
    "DROP TABLE monitor_events;DROP TRIGGER independent_local_dispatch;DROP VIEW brc38_local_baseline_event;"
    "DROP TABLE independent_local_events;") == SQLITE_OK,
    "synthetic v3 transport schema physically retired before original growth test");
  driverFamily = family;
}

/* New finite comparison purpose. Synthetic transport checks do not establish
 * BRC39 authentication, copied semantic equivalence or permanent admission. */
static void recoveryStageContracts(void) {
  const char *root = "/work/recovery-stage-contract";
  profileRequire(mkdir(root, 0700) == 0, "recovery purpose owns new directory");
  Brc38ProfileEnrollment expected = {0}; struct stat actual;
  profileRequire(lstat(root, &actual) == 0, "recovery directory identity");
  expected.directoryDevice = actual.st_dev; expected.directoryInode = actual.st_ino;
  const char *files[] = {"stage.sqlite", "brc38-owner.sqlite"};
  for (int family = 0; family < 2; family++) {
    char file[PATH_MAX];
    profileRequire(snprintf(file, sizeof(file), "%s/%s", root, files[family]) < (int)sizeof(file), "recovery bounded fixture path");
    int fd = open(file, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    profileRequire(fd >= 0 && fstat(fd, &actual) == 0 && actual.st_size == 0, "recovery new empty file identity");
    expected.mainDevice[family] = actual.st_dev; expected.mainInode[family] = actual.st_ino;
    profileRequire(close(fd) == 0, "recovery fixture descriptor drained");
  }
  profileRequire(brc38StageQuotaInitialize(&driverQuota, root, 1048576, &expected) == SQLITE_OK, "recovery unchanged original physical quota");
  driverPrivateStage = driverRecoveryStage = driverCandidateComparison = 1;
  driverAdmitted = driverPromoted = 0;
  driverOriginalStageExpiry = 1;
  driverStageExpiry = privateStageWallMs() + 60000; driverStageDeadline = clockMs() + 60000;
  profileRequire(openNative(1, 0) == SQLITE_OK && controlSql(driverDb[1], "BEGIN IMMEDIATE") == SQLITE_OK &&
    recoveryStageInitializeOwner() == SQLITE_OK && privateStageCheck() == SQLITE_OK,
    "recovery actual new kernel owner with fresh purpose and expired original DATA");
  sqlite3_stmt *check = NULL;
  profileRequire(sqlite3_prepare_v2(driverDb[1], "SELECT originalExpiresAt FROM owner WHERE slot=1", -1, &check, NULL) == SQLITE_OK &&
    sqlite3_step(check) == SQLITE_ROW && sqlite3_column_int64(check, 0) == 1 && sqlite3_finalize(check) == SQLITE_OK,
    "recovery original expiry DATA preserved");
  profileRequire(recoveryStageInitializeOwner() != SQLITE_OK, "recovery existing owner cannot be replaced");
  profileRequire(openNative(0, 0) == SQLITE_OK, "recovery comparison root opened");
  /* Independent vectors against the original SQL predicate, including exact
   * byte/row boundaries, underflow, invalid limits and signed64 corruption. */
  const sqlite3_int64 quotaCases[][8] = {
    {0,0,0,17179869184LL,2147483647,0,4096,1},
    {4096,1,1,17179869184LL,2147483647,4096,0,-1},
    {17179869184LL,2147483647,0,17179869184LL,2147483647,4096,4096,0},
    {0,2147483646,1,17179869184LL,2147483647,0,17179869184LL,1},
    {4096,2147483648LL,0,17179869184LL,2147483647,4096,0,-1},
    {4095,1,0,17179869184LL,2147483647,4096,0,-1},
    {4096,0,0,17179869184LL,2147483647,4096,0,-1},
    {0,2147483647,0,17179869184LL,2147483647,0,4096,1},
    {17179869184LL,1,0,17179869184LL,2147483647,0,1,1},
    {0,0,2,17179869184LL,2147483647,0,4096,1},
    {0,0,0,17179869183LL,2147483647,0,4096,1},
    {0,0,0,17179869184LL,2147483646,0,4096,1},
    {INT64_MAX,INT64_MAX,0,17179869184LL,2147483647,0,INT64_MAX,1}
  };
  for (size_t i = 0; i < sizeof(quotaCases)/sizeof(quotaCases[0]); i++) {
    sqlite3_stmt *oracle = NULL, *candidate = NULL;
    profileRequire(sqlite3_prepare_v2(driverDb[0],
      "SELECT ?1-?6+?7 WHERE ?3 IN (0,1) AND ?1>=?6 AND ?1-?6+?7<=?4 "
      "AND ?2>=CASE WHEN ?8<0 THEN 1 ELSE 0 END AND ?2+?8<=?5 "
      "AND ?4=17179869184 AND ?5=2147483647", -1, &oracle, NULL) == SQLITE_OK &&
      sqlite3_prepare_v2(driverDb[0], "SELECT brc38_shared_quota_next_bytes(?1,?2,?3,?4,?5,?6,?7,?8)",
      -1, &candidate, NULL) == SQLITE_OK, "quota independent original SQL and candidate prepared");
    for (int at = 0; at < 8; at++)
      profileRequire(sqlite3_bind_int64(oracle, at+1, quotaCases[i][at]) == SQLITE_OK &&
        sqlite3_bind_int64(candidate, at+1, quotaCases[i][at]) == SQLITE_OK,
        "quota independent vector bound to both expressions");
    int expected = sqlite3_step(oracle), actualCode = sqlite3_step(candidate);
    profileRequire((expected == SQLITE_ROW && actualCode == SQLITE_ROW &&
      sqlite3_column_type(candidate,0) == SQLITE_INTEGER &&
      sqlite3_column_int64(candidate,0) == sqlite3_column_int64(oracle,0)) ||
      (expected == SQLITE_DONE && actualCode == SQLITE_CONSTRAINT_TRIGGER),
      "quota native next-byte arithmetic/refusal equals independent original SQL");
    profileRequire(sqlite3_finalize(oracle) == SQLITE_OK &&
      sqlite3_finalize(candidate) == (expected == SQLITE_ROW ? SQLITE_OK : SQLITE_CONSTRAINT_TRIGGER),
      "quota independent vector statements physically drained");
  }
  sqlite3_stmt *wrongType = NULL;
  profileRequire(sqlite3_prepare_v2(driverDb[0],
    "SELECT brc38_shared_quota_next_bytes(NULL,0,0,17179869184,2147483647,0,4096,1)",
    -1, &wrongType, NULL) == SQLITE_OK && sqlite3_step(wrongType) == SQLITE_CONSTRAINT_TRIGGER &&
    sqlite3_finalize(wrongType) == SQLITE_CONSTRAINT_TRIGGER,
    "quota missing counter refuses instead of coercing NULL");
  profileRequire(sqlite3_prepare_v2(driverDb[0],
    "SELECT brc38_shared_quota_next_bytes(0.5,0,0,17179869184,2147483647,0,4096,1)",
    -1, &wrongType, NULL) == SQLITE_OK && sqlite3_step(wrongType) == SQLITE_CONSTRAINT_TRIGGER &&
    sqlite3_finalize(wrongType) == SQLITE_CONSTRAINT_TRIGGER,
    "quota fractional counter refuses instead of truncating DATA");
  sqlite3_stmt *charges = NULL;
  profileRequire(sqlite3_prepare_v2(driverDb[0],
    "SELECT brc38_shared_row_charge(12,'é😀'),"
    "brc38_shared_row_charge(-7,''),"
    "brc38_shared_row_charge(9223372036854775807,x'000102'),"
    "brc38_shared_row_charge(NULL,x'',1.25),"
    "brc38_shared_row_charge('a'||char(0)||'b')", -1, &charges, NULL) == SQLITE_OK &&
    sqlite3_step(charges) == SQLITE_ROW && sqlite3_column_count(charges) == 5 &&
    sqlite3_column_type(charges, 0) == SQLITE_INTEGER && sqlite3_column_int64(charges, 0) == 4128 &&
    sqlite3_column_int64(charges, 1) == 4104 && sqlite3_column_int64(charges, 2) == 4184 &&
    sqlite3_column_int64(charges, 3) == 4112 && sqlite3_column_int64(charges, 4) == 4108 &&
    sqlite3_step(charges) == SQLITE_DONE && sqlite3_finalize(charges) == SQLITE_OK,
    "native pure row charges preserve independent UTF8/signed64/blob/empty/NULL/NUL values");
  profileRequire(sqlite3_prepare_v2(driverDb[0], "SELECT brc38_shared_row_charge()", -1, &charges, NULL) == SQLITE_OK &&
    sqlite3_step(charges) == SQLITE_MISUSE && sqlite3_finalize(charges) == SQLITE_MISUSE,
    "native pure row charge refuses missing column inventory");
  profileRequire(sqlite3_prepare_v2(driverDb[0],
    "SELECT brc38_shared_row_charge(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,"
    "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)", -1, &charges, NULL) == SQLITE_OK &&
    sqlite3_step(charges) == SQLITE_MISUSE && sqlite3_finalize(charges) == SQLITE_MISUSE,
    "native pure row charge refuses more than32 columns");
  profileRequire(controlSql(driverDb[0], "CREATE TABLE data(id INTEGER PRIMARY KEY,payload BLOB);INSERT INTO data VALUES(1,x'010203');") == SQLITE_OK,
    "recovery synthetic copied semantic payload installed internally");
  driverFamily = 0; driverAdmitted = 1;
  profileRequire(sqlite3_exec(driverDb[0], "UPDATE data SET payload=x'04'", NULL, NULL, NULL) == SQLITE_AUTH &&
    sqlite3_exec(driverDb[0], "DELETE FROM data", NULL, NULL, NULL) == SQLITE_AUTH &&
    sqlite3_exec(driverDb[0], "CREATE TABLE forbidden(x)", NULL, NULL, NULL) == SQLITE_AUTH,
    "recovery semantic SQL and schema denied from first consumer request");
  sqlite3_blob *blob = NULL;
  profileRequire(brc38OpenNativeBlob(driverDb[0], "main", "data", "payload", 1, 1, &blob) == SQLITE_AUTH && blob == NULL,
    "recovery direct semantic BLOB mutation denied");
  unsigned char payload[3] = {0};
  profileRequire(brc38OpenNativeBlob(driverDb[0], "main", "data", "payload", 1, 0, &blob) == SQLITE_OK &&
    blob != NULL && sqlite3_blob_bytes(blob) == 3 && sqlite3_blob_read(blob, payload, 3, 0) == SQLITE_OK &&
    !memcmp(payload, "\x01\x02\x03", 3) && sqlite3_blob_close(blob) == SQLITE_OK,
    "recovery owned read handle preserves exact original semantic bytes and drains");
  blob = NULL;
  profileRequire(sqlite3_exec(driverDb[0], "SELECT payload FROM data", NULL, NULL, NULL) == SQLITE_OK,
    "recovery actual comparison reads remain available");
  uint64_t expiry = driverStageExpiry, deadline = driverStageDeadline;
  driverStageExpiry = privateStageWallMs();
  profileRequire(privateStageCheck() == SQLITE_AUTH, "recovery fresh UTC expiry denied");
  driverStageExpiry = expiry; driverStageDeadline = clockMs();
  profileRequire(privateStageCheck() == SQLITE_AUTH, "recovery fresh monotonic expiry denied");
  driverStageDeadline = deadline;
  profileRequire(closeNative(0) == SQLITE_OK && closeNative(1) == SQLITE_OK && brc38QuotaClose(&driverQuota) == SQLITE_OK,
    "recovery concrete native/VFS owner drained");
  for (int family = 0; family < 2; family++) {
    char file[PATH_MAX];
    profileRequire(snprintf(file, sizeof(file), "%s/%s", root, files[family]) < (int)sizeof(file) && unlink(file) == 0,
      "recovery exact fresh family cleanup");
  }
  profileRequire(rmdir(root) == 0, "recovery new directory cleanup");
  driverPrivateStage = driverRecoveryStage = driverCandidateComparison = 0;
}
