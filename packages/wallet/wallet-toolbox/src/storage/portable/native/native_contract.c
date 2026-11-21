/* Ordinary SQLite resource/recovery tests. No mutation campaign or faulting
 * native trigger. All data is synthetic and this executable is sandbox-only. */
#include "sqlite3.c"
#include "brc38_quota.c"
#include "brc38_runtime.c"

static int assertions;
static void require(int condition, const char *contract) {
  assertions++;
  if (!condition) { fprintf(stderr, "FAIL %s\n", contract); exit(1); }
}
static void sql(sqlite3 *db, const char *text) {
  char *error = NULL;
  int rc = sqlite3_exec(db, text, NULL, NULL, &error);
  if (rc != SQLITE_OK) {
    fprintf(stderr, "SQL refusal rc=%d: %s\n", rc, error ? error : "unknown");
    sqlite3_free(error); exit(1);
  }
}
static int value(sqlite3 *db, const char *text) {
  sqlite3_stmt *statement = NULL;
  require(sqlite3_prepare_v2(db, text, -1, &statement, NULL) == SQLITE_OK, "prepare bounded scalar");
  require(sqlite3_step(statement) == SQLITE_ROW, "read scalar row");
  int result = sqlite3_column_int(statement, 0);
  require(sqlite3_finalize(statement) == SQLITE_OK, "finalize scalar");
  return result;
}
static sqlite3 *openWallet(Brc38Quota *q) {
  char path[PATH_MAX];
  require(snprintf(path, sizeof(path), "%s/wallet.sqlite", q->root) < (int)sizeof(path), "bounded path");
  sqlite3 *db = NULL;
  require(sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
                        q->vfs.zName) == SQLITE_OK, "actual quota VFS open");
  sql(db, "PRAGMA page_size=4096; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-64;"
          "PRAGMA mmap_size=0; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;"
          "PRAGMA wal_autocheckpoint=0;");
  return db;
}
static sqlite3_int64 actualBytes(Brc38Quota *q) {
  sqlite3_int64 bytes = 0;
  for (int i = 0; i < BRC38_FILE_SLOTS; ++i) {
    struct stat s;
    if (!fstatat(q->directory, brc38Names[i], &s, AT_SYMLINK_NOFOLLOW)) bytes += s.st_size;
    else require(errno == ENOENT, "actual fixed file absence");
  }
  return bytes;
}
static Brc38QuotaFile *databaseFile(sqlite3 *db) {
  sqlite3_file *file = NULL;
  require(sqlite3_file_control(db, "main", SQLITE_FCNTL_FILE_POINTER, &file) == SQLITE_OK,
          "driver exposes guarded file");
  require(file && file->pMethods == &brc38Methods, "no unguarded descriptor escape");
  return (Brc38QuotaFile *)file;
}
static void removeFixture(const char *root) {
  char path[PATH_MAX];
  for (int i = 0; i < BRC38_FILE_SLOTS; ++i) {
    require(snprintf(path, sizeof(path), "%s/%s", root, brc38Names[i]) < (int)sizeof(path), "bounded cleanup path");
    require(!unlink(path) || errno == ENOENT, "physical fixed fixture cleanup");
  }
  require(!rmdir(root), "physical directory cleanup");
}
static void softLimitBaseline(void) {
  const char *root = "/work/soft-limit-baseline";
  require(!mkdir(root, 0700), "create bounded soft-limit baseline fixture");
  char path[PATH_MAX]; snprintf(path, sizeof(path), "%s/wallet.sqlite", root);
  sqlite3 *writer = NULL, *reader = NULL;
  require(sqlite3_open_v2(path, &writer, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, "unix") == SQLITE_OK,
          "independent ordinary Unix baseline open");
  sql(writer, "PRAGMA page_size=4096; PRAGMA max_page_count=16; PRAGMA journal_size_limit=524288;"
              "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;"
              "CREATE TABLE item(id INTEGER PRIMARY KEY,n INTEGER); INSERT INTO item VALUES(1,0);");
  require(sqlite3_open_v2(path, &reader, SQLITE_OPEN_READWRITE, "unix") == SQLITE_OK, "baseline native reader open");
  sql(reader, "BEGIN;");
  require(value(reader, "SELECT n FROM item WHERE id=1") == 0, "baseline pins old snapshot");
  for (int i = 0; i < 300; ++i) sql(writer, "UPDATE item SET n=n+1 WHERE id=1;");
  snprintf(path, sizeof(path), "%s/wallet.sqlite-wal", root);
  struct stat wal;
  require(!lstat(path, &wal) && wal.st_size > 524288, "soft page/journal limits do not bound a retained WAL");
  require(value(writer, "PRAGMA page_count") <= 16, "baseline still honors native main page limit");
  require(value(reader, "SELECT n FROM item WHERE id=1") == 0, "baseline remains coherent despite excess WAL");
  sql(reader, "COMMIT;");
  require(sqlite3_close(reader) == SQLITE_OK && sqlite3_close(writer) == SQLITE_OK, "baseline native physical drain");
  removeFixture(root);
}
static void walContracts(void) {
  const char *root = "/work/wal-contract";
  require(!mkdir(root, 0700), "create private fixture");
  sqlite3_vfs *original = sqlite3_vfs_find(NULL);
  Brc38Quota q;
  require(brc38QuotaInitialize(&q, root, 524288, 32768, 131072) == SQLITE_OK, "fixed native reservation");
  require(sqlite3_vfs_find(NULL) == original, "default VFS is unchanged");
  Brc38Quota conflicting;
  require(brc38QuotaInitialize(&conflicting, root, 1048576, 32768, 131072) == SQLITE_MISUSE,
          "live reservation cannot be overwritten or enlarged");
  sqlite3 *writer = openWallet(&q);
  sql(writer, "PRAGMA journal_mode=WAL; CREATE TABLE item(id INTEGER PRIMARY KEY,n INTEGER NOT NULL);"
              "INSERT INTO item VALUES(1,0);");
  sqlite3 *reader = openWallet(&q);
  sql(reader, "BEGIN;");
  require(value(reader, "SELECT n FROM item WHERE id=1") == 0, "pin actual old read snapshot");
  int commits = 0, rc = SQLITE_OK;
  while (commits < 300 && rc == SQLITE_OK) {
    rc = sqlite3_exec(writer, "BEGIN IMMEDIATE; UPDATE item SET n=n+1 WHERE id=1; COMMIT;", NULL, NULL, NULL);
    if (rc == SQLITE_OK) commits++;
    require(actualBytes(&q) <= q.maximum, "every writer step stays inside native logical extent quota");
  }
  require(rc == SQLITE_FULL && q.refusedGrowth > 0 && commits > 1 && commits < 300,
          "retained reader causes real bounded WAL quota refusal");
  require(sqlite3_get_autocommit(writer), "quota-full transaction actually rolled back");
  require(value(writer, "SELECT n FROM item WHERE id=1") == commits, "failed commit has no partial state");
  require(value(reader, "SELECT n FROM item WHERE id=1") == 0, "concurrent committed writes preserve old snapshot");
  int log = -1, checkpointed = -1;
  rc = sqlite3_wal_checkpoint_v2(writer, "main", SQLITE_CHECKPOINT_TRUNCATE, &log, &checkpointed);
  require(rc == SQLITE_BUSY, "retained read owns checkpoint floor");
  require(value(reader, "SELECT n FROM item WHERE id=1") == 0, "busy checkpoint preserves retained reader");
  sql(reader, "COMMIT;");
  require(sqlite3_wal_checkpoint_v2(writer, "main", SQLITE_CHECKPOINT_TRUNCATE, &log, &checkpointed) == SQLITE_OK,
          "actual read drain permits truncating checkpoint");
  require(q.slots[2].charged == 0, "WAL reservation reclaimed only after actual successful truncate");
  sql(writer, "UPDATE item SET n=n+1 WHERE id=1;");
  require(value(reader, "SELECT n FROM item WHERE id=1") == commits+1, "new read sees recovered committed writer");
  require(brc38QuotaClose(&q) == SQLITE_BUSY, "cannot release owner with native connections");
  Brc38QuotaFile *native = databaseFile(writer);
  struct stat before, after;
  require(!fstat(((unixFile *)native->real)->h, &before), "actual descriptor before size hint");
  sqlite3_int64 hint = 16 * 1024 * 1024;
  require(sqlite3_file_control(writer, "main", SQLITE_FCNTL_SIZE_HINT, &hint) == SQLITE_OK,
          "unchecked preallocation hint is consumed");
  require(!fstat(((unixFile *)native->real)->h, &after) && after.st_size == before.st_size,
          "size hint cannot allocate outside reservation");
  sqlite3_int64 mapping = 16 * 1024 * 1024;
  require(sqlite3_file_control(writer, "main", SQLITE_FCNTL_MMAP_SIZE, &mapping) == SQLITE_OK && mapping == 0,
          "data mmap is disabled at actual VFS");
  void volatile *mapped = NULL;
  require(native->base.pMethods->xShmMap(&native->base, 1, 32768, 1, &mapped) == SQLITE_FULL && mapped == NULL,
          "SHM growth refuses before underlying mapping");
  require(actualBytes(&q) <= q.maximum, "SHM refusal retains actual byte bound");
  sqlite3 *handles[6] = {NULL};
  int opened = 0;
  char path[PATH_MAX]; snprintf(path, sizeof(path), "%s/wallet.sqlite", root);
  for (; opened < 6 && q.handles < BRC38_MAX_HANDLES; ++opened)
    require(sqlite3_open_v2(path, &handles[opened], SQLITE_OPEN_READWRITE, q.vfs.zName) == SQLITE_OK,
            "bounded independent native handle");
  sqlite3 *tooMany = NULL;
  require(sqlite3_open_v2(path, &tooMany, SQLITE_OPEN_READWRITE, q.vfs.zName) == SQLITE_CANTOPEN,
          "actual native open handle limit");
  require(sqlite3_close(tooMany) == SQLITE_OK, "failed open is physically closed");
  for (int i = 0; i < opened; ++i) require(sqlite3_close(handles[i]) == SQLITE_OK, "extra native reader drain");
  require(sqlite3_close(reader) == SQLITE_OK && sqlite3_close(writer) == SQLITE_OK, "native read writer drain");
  require(q.handles == 0 && q.slots[3].identity == 0, "native close proves SHM unlink and clears only dead identity");
  require(brc38QuotaClose(&q) == SQLITE_OK, "owner physically releases after native drain");
  require(brc38QuotaInitialize(&q, root, 524288, 32768, 131072) == SQLITE_OK, "reopen scans same fixed capacity");
  writer = openWallet(&q);
  require(value(writer, "SELECT n FROM item WHERE id=1") == commits+1, "reopen retains exact committed state");
  sqlite3_stmt *integrity = NULL;
  require(sqlite3_prepare_v2(writer, "PRAGMA integrity_check", -1, &integrity, NULL) == SQLITE_OK,
          "prepare actual integrity check");
  require(sqlite3_step(integrity) == SQLITE_ROW
          && !strcmp((const char *)sqlite3_column_text(integrity, 0), "ok")
          && sqlite3_step(integrity) == SQLITE_DONE, "reopened native database integrity is exactly ok");
  require(sqlite3_finalize(integrity) == SQLITE_OK, "integrity statement drained");
  require(sqlite3_close(writer) == SQLITE_OK && brc38QuotaClose(&q) == SQLITE_OK, "reopened native drain");
  removeFixture(root);
}

static void rollbackAndIdentityContracts(void) {
  const char *root = "/work/rollback-contract";
  require(!mkdir(root, 0700), "create rollback fixture");
  Brc38Quota q;
  require(brc38QuotaInitialize(&q, root, 98304, 32768, 32768) == SQLITE_OK, "rollback fixed reservation");
  sqlite3 *db = openWallet(&q);
  sql(db, "CREATE TABLE item(id INTEGER PRIMARY KEY,data BLOB); INSERT INTO item VALUES(1,zeroblob(512));");
  int rc = sqlite3_exec(db, "BEGIN IMMEDIATE; INSERT INTO item VALUES(2,zeroblob(131072)); COMMIT;", NULL, NULL, NULL);
  require(rc == SQLITE_FULL, "actual DELETE journal/database quota refusal");
  if (!sqlite3_get_autocommit(db)) sql(db, "ROLLBACK;");
  require(value(db, "SELECT count(*) FROM item") == 1, "DELETE quota failure preserves original committed row");
  sql(db, "INSERT INTO item VALUES(3,zeroblob(512));");
  require(value(db, "SELECT count(*) FROM item") == 2, "DELETE writer works after rollback");
  Brc38QuotaFile *f = databaseFile(db);
  char unexpected[PATH_MAX]; snprintf(unexpected, sizeof(unexpected), "%s/unexpected", root);
  int fd = open(unexpected, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  require(fd >= 0 && !close(fd), "create ordinary unexpected fixture entry");
  require(f->base.pMethods->xSync(&f->base, SQLITE_SYNC_FULL) == SQLITE_IOERR,
          "actual anchored directory inventory refuses unowned entry");
  require(!unlink(unexpected), "remove exact unexpected fixture entry");
  char original[PATH_MAX], moved[PATH_MAX];
  snprintf(original, sizeof(original), "%s/wallet.sqlite", root);
  snprintf(moved, sizeof(moved), "/work/rollback-original.sqlite");
  require(!rename(original, moved), "move synthetic owned inode");
  fd = open(original, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  require(fd >= 0 && !close(fd), "create ordinary replacement inode");
  struct stat nativeBefore, nativeAfter, replacement;
  require(!fstat(((unixFile *)f->real)->h, &nativeBefore), "actual old descriptor remains concrete");
  unsigned char page[4096] = {0};
  require(f->base.pMethods->xWrite(&f->base, page, sizeof(page), nativeBefore.st_size) == SQLITE_IOERR,
          "replacement inode refuses before underlying descriptor write");
  require(!fstat(((unixFile *)f->real)->h, &nativeAfter) && nativeAfter.st_size == nativeBefore.st_size
          && !lstat(original, &replacement) && replacement.st_size == 0,
          "identity refusal changes neither owned descriptor nor replacement");
  require(!unlink(original) && !rename(moved, original), "restore exact owned fixture inode");
  require(value(db, "SELECT count(*) FROM item") == 2, "restored identity retains committed rows");
  require(sqlite3_close(db) == SQLITE_OK && q.handles == 0 && brc38QuotaClose(&q) == SQLITE_OK,
          "refused ownership still physically drains");
  removeFixture(root);
}

static void nativeMemoryContracts(void) {
  require(brc38NativeRuntimeInitialize(64 * 1024 * 1024, 8 * 1024 * 1024, 64) == SQLITE_MISUSE,
          "native process reservation cannot be rebound or enlarged");
  struct rlimit address, files;
  require(!getrlimit(RLIMIT_AS, &address) && address.rlim_cur == (rlim_t)brc38RuntimeAddressMaximum
          && address.rlim_max == address.rlim_cur, "actual immutable kernel address-space limit");
  require(!getrlimit(RLIMIT_NOFILE, &files) && files.rlim_cur == (rlim_t)brc38RuntimeDescriptors
          && files.rlim_max == files.rlim_cur, "actual immutable kernel descriptor limit");
  int descriptors[64], count = 0;
  while (count < 64) {
    int fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (fd < 0) break;
    descriptors[count++] = fd;
  }
  require(count > 0 && count < 64 && errno == EMFILE, "kernel actually refuses descriptor exhaustion");
  for (int i = 0; i < count; ++i) require(!close(descriptors[i]), "every synthetic descriptor physically drains");
  require(sqlite3_hard_heap_limit64(-1) == brc38RuntimeHeapMaximum, "actual native SQLite hard allocator limit");
  sqlite3 *db = NULL;
  require(sqlite3_open(":memory:", &db) == SQLITE_OK, "ordinary bounded allocation test connection");
  sql(db, "CREATE TABLE item(n INTEGER); INSERT INTO item VALUES(7);");
  sqlite3_stmt *statement = NULL;
  require(sqlite3_prepare_v2(db, "SELECT hex(zeroblob(4194304))", -1, &statement, NULL) == SQLITE_OK,
          "prepare ordinary operation above admitted allocator budget");
  require(sqlite3_step(statement) == SQLITE_NOMEM, "actual allocation refuses before oversized result delivery");
  require(sqlite3_finalize(statement) == SQLITE_NOMEM, "failed allocation statement physically releases");
  require(sqlite3_memory_highwater(0) <= brc38RuntimeHeapMaximum, "native SQLite peak stays under hard budget");
  require(value(db, "SELECT n FROM item") == 7, "allocator refusal leaves committed database usable");
  require(sqlite3_close(db) == SQLITE_OK, "allocation test native handle drain");
  struct rusage usage;
  sqlite3_int64 rssScale =
#if defined(__APPLE__) && defined(__MACH__)
      1;
#else
      1024;
#endif
  require(!getrusage(RUSAGE_SELF, &usage) && (sqlite3_int64)usage.ru_maxrss * rssScale <= brc38RuntimeAddressMaximum,
          "observed isolated native RSS stays inside kernel address bound");
}

static void processLossWriter(void) {
  const char *root = "/work/process-loss-contract";
  require(!mkdir(root, 0700), "create process-loss owned fixture");
  Brc38Quota q;
  require(brc38QuotaInitialize(&q, root, 524288, 32768, 131072) == SQLITE_OK, "process-loss fixed reservation");
  sqlite3 *db = openWallet(&q);
  sql(db, "PRAGMA journal_mode=WAL; CREATE TABLE item(id INTEGER PRIMARY KEY,n INTEGER NOT NULL);"
          "BEGIN IMMEDIATE; INSERT INTO item VALUES(1,41); COMMIT;");
  require(value(db, "SELECT n FROM item WHERE id=1") == 41, "destination-authoritative committed value");
  require(actualBytes(&q) <= q.maximum, "committed process retains original capacity");
  printf("{\"phase\":\"committed\",\"pid\":%ld,\"value\":41}\n", (long)getpid());
  fflush(stdout);
  /* The harness terminates this healthy, idle, owned process. No faulting
   * native mutation, inherited SQLite connection, or crashing input exists. */
  for (;;) pause();
}
static void processLossRecovery(void) {
  const char *root = "/work/process-loss-contract";
  Brc38Quota q;
  require(brc38QuotaInitialize(&q, root, 524288, 32768, 131072) == SQLITE_OK, "restart scans original extents");
  sqlite3 *db = openWallet(&q);
  require(value(db, "SELECT n FROM item WHERE id=1") == 41, "killed writer's exact committed WAL recovered");
  sql(db, "UPDATE item SET n=n+1 WHERE id=1;");
  require(value(db, "SELECT n FROM item WHERE id=1") == 42, "restarted destination continues exactly once");
  int log = -1, checkpointed = -1;
  require(sqlite3_wal_checkpoint_v2(db, "main", SQLITE_CHECKPOINT_TRUNCATE, &log, &checkpointed) == SQLITE_OK,
          "recovered writer completes native checkpoint");
  require(actualBytes(&q) <= q.maximum && q.slots[2].charged == 0, "restart neither enlarges nor resets quota");
  require(sqlite3_close(db) == SQLITE_OK && q.handles == 0 && brc38QuotaClose(&q) == SQLITE_OK,
          "recovered kernel handles drain");
  removeFixture(root);
  printf("{\"phase\":\"recovered\",\"assertions\":%d,\"value\":42,\"fixturesDrained\":true}\n", assertions);
}

int main(int argc, char **argv) {
  umask(0077);
  require(brc38NativeRuntimeInitialize(32 * 1024 * 1024, 4 * 1024 * 1024, 32) == SQLITE_OK,
          "actual private process kernel and allocator admission");
  if (argc == 2 && !strcmp(argv[1], "--process-loss-writer")) { processLossWriter(); return 1; }
  if (argc == 2 && !strcmp(argv[1], "--process-loss-recovery")) { processLossRecovery(); return 0; }
  require(argc == 1, "no unknown native harness mode");
  softLimitBaseline(); walContracts(); rollbackAndIdentityContracts(); nativeMemoryContracts();
  require(sqlite3_shutdown() == SQLITE_OK, "native SQLite shutdown");
  printf("{\"assertions\":%d,\"wal\":true,\"rollback\":true,\"descriptorIdentity\":true,"
         "\"fixturesDrained\":true,\"productionQualified\":false}\n", assertions);
  return 0;
}
