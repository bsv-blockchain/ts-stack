/* Ordinary three-family profile ownership tests, synthetic fixtures only.
 * The expected identity vector models the verified original receipt fields;
 * this does not prove receipt authentication, activation or a production driver. */
static int profileChecks;
static void profileRequire(int condition, const char *contract) {
  profileChecks++;
  if (!condition) { fprintf(stderr, "PROFILE FAIL %s\n", contract); exit(1); }
}
static sqlite3 *profileOpen(Brc38Quota *q, int family) {
  char path[PATH_MAX];
  profileRequire(snprintf(path, sizeof(path), "%s/%s", q->root, brc38Names[family * 4]) < (int)sizeof(path),
                 "bounded admitted native family path");
  sqlite3 *db = NULL;
  profileRequire(sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, q->vfs.zName) == SQLITE_OK,
                 "open original guarded family connection");
  sql(db, "PRAGMA page_size=4096; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-64;"
          "PRAGMA mmap_size=0; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;");
  return db;
}
static sqlite3_int64 profileBytes(Brc38Quota *q) {
  sqlite3_int64 bytes = 0;
  for (int i = 0; i < q->families * 4; ++i) {
    struct stat s;
    if (!fstatat(q->directory, brc38Names[i], &s, AT_SYMLINK_NOFOLLOW)) bytes += s.st_size;
    else profileRequire(errno == ENOENT, "known native family member physically absent");
  }
  return bytes;
}
static void profileRemove(const char *root) {
  char path[PATH_MAX];
  for (int i = 0; i < BRC38_PROFILE_SLOTS; ++i) {
    profileRequire(snprintf(path, sizeof(path), "%s/%s", root, brc38Names[i]) < (int)sizeof(path),
                   "bounded profile cleanup path");
    profileRequire(!unlink(path) || errno == ENOENT, "physical admitted profile member drain");
  }
  profileRequire(!rmdir(root), "physical profile directory drain");
}
static void profileContracts(void) {
  const char *root = "/work/profile-contract";
  profileRequire(!mkdir(root, 0700), "private original profile directory");
  Brc38ProfileEnrollment expected;
  struct stat s;
  profileRequire(!lstat(root, &s), "read original directory identity");
  expected.directoryDevice = s.st_dev; expected.directoryInode = s.st_ino;
  for (int family = 0; family < 3; ++family) {
    char path[PATH_MAX];
    profileRequire(snprintf(path, sizeof(path), "%s/%s", root, brc38Names[family * 4]) < (int)sizeof(path),
                   "fixed original main file path");
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    profileRequire(fd >= 0 && !fstat(fd, &s), "create actual private original main file");
    expected.mainDevice[family] = s.st_dev; expected.mainInode[family] = s.st_ino;
    profileRequire(!close(fd), "drain preparatory file descriptor");
  }
  sqlite3_vfs *defaultVfs = sqlite3_vfs_find(NULL);
  Brc38Quota old, refused;
  profileRequire(brc38QuotaInitialize(&old, root, 1048576, 32768, 303104) == SQLITE_CANTOPEN,
                 "original wallet-only VFS refuses actual metadata family directory");
  Brc38ProfileEnrollment wrong = expected; wrong.directoryInode++;
  profileRequire(brc38ProfileQuotaInitialize(&refused, root, 1048576, &wrong) == SQLITE_CANTOPEN,
                 "stale original directory enrollment refused");
  for (int family = 0; family < 3; ++family) {
    wrong = expected; wrong.mainInode[family]++;
    profileRequire(brc38ProfileQuotaInitialize(&refused, root, 1048576, &wrong) == SQLITE_CANTOPEN,
                   "each stale original main identity refused before native open");
  }
  profileRequire(sqlite3_vfs_find("brc38-owner-quota") == NULL,
                 "refused enrollment leaves no replacement VFS or native handle");
  Brc38Quota q;
  profileRequire(brc38ProfileQuotaInitialize(&q, root, 1048576, &expected) == SQLITE_OK,
                 "same original one-MiB profile admitted with all original identities");
  profileRequire(q.maximum == 1048576 && q.families == 3 && q.mainMaximum[1] == 16384
                 && q.mainMaximum[2] == 32768 && q.mainMaximum[0] == 303104,
                 "original profile wallet/owner/catalog page allowances retained inside aggregate");
  profileRequire(sqlite3_vfs_find(NULL) == defaultVfs, "no caller default VFS replacement");
  profileRequire(brc38ProfileQuotaInitialize(&refused, root, 2097152, &expected) == SQLITE_MISUSE,
                 "live native reservation cannot rebind or enlarge original admission");
  sqlite3 *owner = profileOpen(&q, 1), *catalog = profileOpen(&q, 2);
  sql(owner, "PRAGMA journal_mode=DELETE; CREATE TABLE owner(slot INTEGER PRIMARY KEY,binding TEXT NOT NULL);"
             "INSERT INTO owner VALUES(1,'original-binding');");
  sql(catalog, "PRAGMA journal_mode=DELETE; CREATE TABLE profile(slot INTEGER PRIMARY KEY,state TEXT NOT NULL,"
               "fixedJson TEXT NOT NULL,fixedSha256 TEXT NOT NULL,copySha256 TEXT,copyBytes INTEGER);"
               "INSERT INTO profile VALUES(1,'READY','original-verified-receipt','original-fixed-sha','original-copy',4096);");
  sql(owner, "BEGIN IMMEDIATE; UPDATE owner SET binding='held-original-binding' WHERE slot=1;");
  profileRequire(q.slots[5].charged > 0, "actual original owner rollback journal charged");
  sqlite3 *competing = profileOpen(&q, 1);
  profileRequire(sqlite3_exec(competing, "BEGIN IMMEDIATE;", NULL, NULL, NULL) == SQLITE_BUSY,
                 "actual independent native owner writer refused by kernel lock");
  profileRequire(sqlite3_close(competing) == SQLITE_OK, "competing owner native connection physically drained");
  sqlite3 *writer = profileOpen(&q, 0);
  sql(writer, "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;"
              "CREATE TABLE item(id INTEGER PRIMARY KEY,n INTEGER NOT NULL); INSERT INTO item VALUES(1,0);");
  sqlite3 *reader = profileOpen(&q, 0);
  sql(reader, "BEGIN;");
  profileRequire(value(reader, "SELECT n FROM item WHERE id=1") == 0, "native reader owns coherent profile snapshot");
  int commits = 0, rc = SQLITE_OK;
  while (commits < 400 && rc == SQLITE_OK) {
    rc = sqlite3_exec(writer, "BEGIN IMMEDIATE; UPDATE item SET n=n+1 WHERE id=1; COMMIT;", NULL, NULL, NULL);
    if (rc == SQLITE_OK) commits++;
    profileRequire(profileBytes(&q) <= q.maximum, "all three actual file families remain inside original total");
  }
  profileRequire(rc == SQLITE_FULL && commits > 0 && commits < 400, "wallet WAL refused within shared unchanged quota");
  if (!sqlite3_get_autocommit(writer)) sql(writer, "ROLLBACK;");
  profileRequire(value(writer, "SELECT n FROM item WHERE id=1") == commits, "failed wallet commit made no extra update");
  profileRequire(value(reader, "SELECT n FROM item WHERE id=1") == 0, "held profile reader remains coherent after quota refusal");
  profileRequire(q.handles <= BRC38_MAX_HANDLES && BRC38_MAX_HANDLES == 8,
                 "three families do not enlarge original eight native wrapper handles");
  profileRequire(brc38QuotaClose(&q) == SQLITE_BUSY, "quota lifetime fenced by actual native connections");
  int logPages = 0, copiedPages = 0;
  profileRequire(sqlite3_wal_checkpoint_v2(writer, NULL, SQLITE_CHECKPOINT_TRUNCATE, &logPages, &copiedPages) == SQLITE_BUSY,
                 "checkpoint waits for actual held reader without extending aggregate allowance");
  rc = sqlite3_exec(catalog, "BEGIN IMMEDIATE; UPDATE profile SET state='PRESSURE' WHERE slot=1; COMMIT;", NULL, NULL, NULL);
  profileRequire(rc == SQLITE_FULL, "actual catalog rollback journal shares exhausted unchanged wallet allowance");
  if (!sqlite3_get_autocommit(catalog)) sql(catalog, "ROLLBACK;");
  profileRequire(value(catalog, "SELECT count(*) FROM profile WHERE state='READY'") == 1,
                 "refused native catalog write preserves its original committed state");
  profileRequire(profileBytes(&q) <= q.maximum, "metadata failure cannot grow total beyond original admission");
  sql(reader, "COMMIT;");
  profileRequire(sqlite3_close(reader) == SQLITE_OK, "actual profile reader native handle drain");
  profileRequire(sqlite3_wal_checkpoint_v2(writer, NULL, SQLITE_CHECKPOINT_TRUNCATE, &logPages, &copiedPages) == SQLITE_OK,
                 "all admitted main extents leave headroom for drained checkpoint");
  sql(catalog, "BEGIN IMMEDIATE; UPDATE profile SET state='ACTIVE' WHERE slot=1; COMMIT;");
  profileRequire(value(catalog, "SELECT count(*) FROM profile WHERE state='ACTIVE'") == 1,
                 "native catalog progresses after wallet pressure clears");
  sql(owner, "ROLLBACK;");
  profileRequire(value(owner, "SELECT count(*) FROM owner WHERE binding='original-binding'") == 1,
                 "owned metadata native rollback preserves original durable row");
  sql(owner, "BEGIN IMMEDIATE; UPDATE owner SET binding='next-binding' WHERE slot=1; COMMIT;");
  profileRequire(q.slots[0].identity && q.slots[4].identity && q.slots[8].identity,
                 "every original main identity remains anchored throughout native lifetime");
  for (int family = 0; family < 3; ++family)
    profileRequire(q.slots[family * 4].device == expected.mainDevice[family]
                   && q.slots[family * 4].inode == expected.mainInode[family],
                   "actual native descriptor still belongs to original main identity");
  profileRequire(sqlite3_close(writer) == SQLITE_OK && sqlite3_close(owner) == SQLITE_OK
                 && sqlite3_close(catalog) == SQLITE_OK, "all wallet and metadata native handles physically drained");
  profileRequire(q.handles == 0 && brc38QuotaClose(&q) == SQLITE_OK, "original profile quota released only after actual drain");
  Brc38Quota reopened;
  profileRequire(brc38ProfileQuotaInitialize(&reopened, root, 1048576, &expected) == SQLITE_OK,
                 "reopen fixed aggregate with original identities");
  sqlite3 *again = profileOpen(&reopened, 0), *metadata = profileOpen(&reopened, 2), *claim = profileOpen(&reopened, 1);
  profileRequire(value(again, "SELECT n FROM item WHERE id=1") == commits, "wallet commits durable after complete native reopen");
  profileRequire(value(metadata, "SELECT count(*) FROM profile WHERE state='ACTIVE'") == 1,
                 "catalog update durable after complete native reopen");
  profileRequire(value(claim, "SELECT count(*) FROM owner WHERE binding='next-binding'") == 1,
                 "owner update durable after complete native reopen");
  profileRequire(sqlite3_close(again) == SQLITE_OK && sqlite3_close(metadata) == SQLITE_OK
                 && sqlite3_close(claim) == SQLITE_OK && brc38QuotaClose(&reopened) == SQLITE_OK,
                 "reopened family quota and handles physically drained");
  profileRemove(root);
  printf("PASS profile checks=%d unchangedAggregate=1048576 unchangedWrapperHandles=8 families=3\n", profileChecks);
}
