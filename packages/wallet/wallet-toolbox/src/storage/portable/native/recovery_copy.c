/* A new, finite scratch copy of a genuine retained Root3 snapshot. This is
 * physical transport only: copied bytes, descriptors and image hashes never
 * authenticate an archive, admit a pending profile or renew an import lease.
 * The destination owns a separate quota VFS under the existing process heap,
 * descriptor and IPC ceilings. Each request copies at most sixteen pages. */
static Brc38Quota recoveryCopyQuota;
static sqlite3 *recoveryCopyDb, *recoveryCopyOwner;
static sqlite3_backup *recoveryCopy;
static uint64_t recoveryCopyExpiry, recoveryCopyDeadline;
static int recoveryCopyPages, recoveryCopyRemaining, recoveryCopyDone;
static int recoveryCopyCharged;

static uint64_t recoveryCopyWallMs(void) {
#if SQLITE_OS_WIN
  FILETIME wall;
  GetSystemTimeAsFileTime(&wall);
  uint64_t ticks = ((uint64_t)wall.dwHighDateTime << 32) | wall.dwLowDateTime;
  if (ticks < UINT64_C(116444736000000000)) return UINT64_MAX;
  return (ticks - UINT64_C(116444736000000000)) / 10000;
#else
  struct timespec now;
  if (clock_gettime(CLOCK_REALTIME, &now) || now.tv_sec < 0) return UINT64_MAX;
  return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
#endif
}
static void brc38RecoveryCopyProtocol(sqlite3_context *context, int argc,
                                    sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_int(context, !driverPrivateStage && !driverRetiredRead ? 1 : 0);
}
static int recoveryCopyClose(void) {
  int rc = SQLITE_OK;
  if (recoveryCopy) {
    rc = sqlite3_backup_finish(recoveryCopy);
    recoveryCopy = NULL;
  }
  if (recoveryCopyDb) {
    int closed = sqlite3_close(recoveryCopyDb);
    if (closed == SQLITE_OK) recoveryCopyDb = NULL;
    else rc = closed;
  }
  if (recoveryCopyOwner) {
    int closed = sqlite3_close(recoveryCopyOwner);
    if (closed == SQLITE_OK) recoveryCopyOwner = NULL;
    else rc = closed;
  }
  if (recoveryCopyCharged && !recoveryCopyDb && !recoveryCopyOwner) {
    int closed = brc38QuotaClose(&recoveryCopyQuota);
    if (closed == SQLITE_OK) recoveryCopyCharged = 0;
    else rc = closed;
  }
  return rc;
}
static int recoveryCopySource(void) {
  if (driverPrivateStage || driverRetiredRead || driverAdmitted || driverPromoted ||
      driverSourceRetirementFrozen || !driverDb[3] || driverFenced[3] ||
      sqlite3_db_readonly(driverDb[3], "main") != 1 ||
      sqlite3_get_autocommit(driverDb[3]) ||
      sqlite3_txn_state(driverDb[3], "main") != SQLITE_TXN_READ ||
      (driverDb[0] && (!sqlite3_get_autocommit(driverDb[0]) || driverFenced[0])) ||
      !driverDb[2] || driverFenced[2] || !sqlite3_get_autocommit(driverDb[2]))
    return SQLITE_AUTH;
  int forward = 0, retired = 0;
  int rc = profileCatalogNamespace(&forward, &retired);
  return rc == SQLITE_OK && retired ? SQLITE_AUTH : rc;
}
static int recoveryCopyCheck(void) {
  if (!recoveryCopyCharged || !recoveryCopyOwner || !recoveryCopyDb ||
      recoveryCopyWallMs() >= recoveryCopyExpiry || clockMs() >= recoveryCopyDeadline ||
      sqlite3_get_autocommit(recoveryCopyOwner) ||
      sqlite3_txn_state(recoveryCopyOwner, "main") != SQLITE_TXN_WRITE)
    return SQLITE_AUTH;
  int rc = recoveryCopySource();
  return rc == SQLITE_OK ? brc38Directory(&recoveryCopyQuota) : rc;
}
static int recoveryCopyScalar(const char *sql, int *value) {
  sqlite3_stmt *statement = NULL;
  int rc = sqlite3_prepare_v2(driverDb[3], sql, -1, &statement, NULL);
  if (rc == SQLITE_OK) {
    rc = sqlite3_step(statement);
    if (rc == SQLITE_ROW && sqlite3_column_type(statement, 0) == SQLITE_INTEGER &&
        sqlite3_column_int64(statement, 0) >= 1 &&
        sqlite3_column_int64(statement, 0) <= INT_MAX) {
      *value = sqlite3_column_int(statement, 0);
      rc = sqlite3_step(statement) == SQLITE_DONE ? SQLITE_OK : SQLITE_AUTH;
    } else if (rc == SQLITE_ROW || rc == SQLITE_DONE) rc = SQLITE_AUTH;
  }
  int finalized = sqlite3_finalize(statement);
  return rc == SQLITE_OK ? finalized : rc;
}
static int recoveryCopyStart(const unsigned char *p, const unsigned char *end) {
  if (recoveryCopyCharged || recoveryCopyDb || recoveryCopyOwner || recoveryCopy ||
      end - p < 77 || recoveryCopySource() != SQLITE_OK) return SQLITE_AUTH;
  uint32_t length = get32(p + 1);
  if (length < 1 || length >= PATH_MAX || end - p != (ptrdiff_t)(77 + length) ||
      memchr(p + 5, 0, length)) return SQLITE_MISUSE;
#if SQLITE_OS_UNIX
  if (p[5] != '/') return SQLITE_MISUSE;
#endif
  char root[PATH_MAX];
  memcpy(root, p + 5, length); root[length] = 0;
  const unsigned char *numbers = p + 5 + length;
  uint64_t maximum = get64(numbers), expiresAt = get64(numbers + 8),
           remaining = get64(numbers + 16), wall = recoveryCopyWallMs(), mono = clockMs();
  if (maximum < 1048576 || maximum > UINT64_C(9007199254740991) ||
      maximum > (uint64_t)driverQuota.maximum || expiresAt > UINT64_C(9007199254740991) ||
      wall >= expiresAt || expiresAt - wall > UINT64_C(3600000) || remaining < 1 ||
      remaining > UINT64_C(3600000) || mono == UINT64_MAX ||
      mono > UINT64_MAX - remaining || !strcmp(root, driverQuota.root)) return SQLITE_AUTH;
  Brc38ProfileEnrollment expected = {0};
  expected.directoryDevice = (Brc38Device)get64(numbers + 24);
  expected.directoryInode = (Brc38Inode)get64(numbers + 32);
  for (int i = 0; i < 2; i++) {
    expected.mainDevice[i] = (Brc38Device)get64(numbers + 40 + i * 16);
    expected.mainInode[i] = (Brc38Inode)get64(numbers + 48 + i * 16);
  }
  sqlite3_int64 pages = ((sqlite3_int64)maximum - 65536) / (3 * 4096);
  if (pages > 2147483646) pages = 2147483646;
  int rc = brc38QuotaConfigureNamed(&recoveryCopyQuota, root, (sqlite3_int64)maximum,
      0, pages * 4096, &expected, 1, "brc38-recovery-copy-quota");
  if (rc != SQLITE_OK) return rc;
  recoveryCopyCharged = 1;
  if (recoveryCopyQuota.slots[0].charged || recoveryCopyQuota.slots[4].charged) return SQLITE_AUTH;
  recoveryCopyExpiry = expiresAt;
  if (remaining > expiresAt - wall) remaining = expiresAt - wall;
  recoveryCopyDeadline = mono + remaining;
  recoveryCopyDone = 0;
  int pageSize = 0;
  rc = recoveryCopyScalar("PRAGMA page_size", &pageSize);
  if (rc == SQLITE_OK) rc = recoveryCopyScalar("PRAGMA page_count", &recoveryCopyPages);
  if (rc == SQLITE_OK && (pageSize != 4096 || recoveryCopyPages > pages)) rc = SQLITE_FULL;
  char filename[PATH_MAX], pragmas[256];
  for (int family = 1; family >= 0 && rc == SQLITE_OK; family--) {
    if (snprintf(filename, sizeof(filename), "%s/%s", root,
                 recoveryCopyQuota.names[family * 4]) >= (int)sizeof(filename)) {
      rc = SQLITE_CANTOPEN; break;
    }
    sqlite3 **database = family ? &recoveryCopyOwner : &recoveryCopyDb;
    rc = sqlite3_open_v2(filename, database, SQLITE_OPEN_READWRITE, recoveryCopyQuota.vfs.zName);
    if (rc == SQLITE_OK) {
      int bytes = snprintf(pragmas, sizeof(pragmas),
        "PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"
        "PRAGMA fullfsync=ON; PRAGMA cache_size=-%lld; PRAGMA temp_store=MEMORY;"
        "PRAGMA mmap_size=0; PRAGMA busy_timeout=0; PRAGMA max_page_count=%lld;",
        (long long)nativeCacheKiB(),
        (long long)(recoveryCopyQuota.mainMaximum[family] / 4096));
      rc = bytes < 1 || bytes >= (int)sizeof(pragmas) ? SQLITE_MISUSE :
        sqlite3_exec(*database, pragmas, NULL, NULL, NULL);
    }
  }
  if (rc == SQLITE_OK) rc = sqlite3_exec(recoveryCopyOwner, "BEGIN IMMEDIATE", NULL, NULL, NULL);
  if (rc == SQLITE_OK) rc = recoveryCopyCheck();
  if (rc == SQLITE_OK) {
    recoveryCopy = sqlite3_backup_init(recoveryCopyDb, "main", driverDb[3], "main");
    if (!recoveryCopy) rc = sqlite3_errcode(recoveryCopyDb);
  }
  recoveryCopyRemaining = recoveryCopyPages;
  return rc;
}
static int recoveryCopyStep(void) {
  int rc = recoveryCopyCheck();
  if (rc != SQLITE_OK || !recoveryCopy || recoveryCopyDone) return rc == SQLITE_OK ? SQLITE_AUTH : rc;
  sqlite3_progress_handler(recoveryCopyDb, 1000, progress, NULL);
  driverDeadline = clockMs() + 10000;
  if (driverDeadline > recoveryCopyDeadline) driverDeadline = recoveryCopyDeadline;
  int previous = recoveryCopyRemaining;
  rc = sqlite3_backup_step(recoveryCopy, 16);
  sqlite3_progress_handler(recoveryCopyDb, 0, NULL, NULL);
  recoveryCopyRemaining = sqlite3_backup_remaining(recoveryCopy);
  if ((rc == SQLITE_OK || rc == SQLITE_DONE) &&
      (sqlite3_backup_pagecount(recoveryCopy) != recoveryCopyPages ||
       recoveryCopyRemaining < 0 || recoveryCopyRemaining >= previous ||
       previous - recoveryCopyRemaining > 16)) rc = SQLITE_AUTH;
  if (rc == SQLITE_DONE) { recoveryCopyDone = 1; rc = SQLITE_OK; }
  return rc == SQLITE_OK ? recoveryCopyCheck() : rc;
}
/* Finalize the new copy through the pinned SQLite engine's
 * rollback journal. Backup copies WAL header versions even into a DELETE
 * destination. Its ordinary SQL reopen would try to create forbidden WAL
 * files before a PRAGMA could switch the format. This engine transition owns
 * the rollback journal, sync, locks and page write under this same quota VFS.
 * The original source and financial admission remain untouched. */
static int recoveryCopyFinalize(void) {
  int rc = recoveryCopyCheck();
  if (rc != SQLITE_OK || !recoveryCopy || !recoveryCopyDone || recoveryCopyRemaining)
    return rc == SQLITE_OK ? SQLITE_AUTH : rc;
  sqlite3_backup *finished = recoveryCopy;
  recoveryCopy = NULL;
  rc = sqlite3_backup_finish(finished);
  if (rc != SQLITE_OK) return rc;
  rc = recoveryCopyCheck();
  if (rc != SQLITE_OK) return rc;
  sqlite3_mutex_enter(sqlite3_db_mutex(recoveryCopyDb));
  Btree *tree = recoveryCopyDb->aDb[0].pBt;
  sqlite3BtreeEnter(tree);
  rc = sqlite3BtreeSetVersion(tree, 1);
  if (rc == SQLITE_OK) rc = sqlite3BtreeCommit(tree);
  if (rc != SQLITE_OK) {
    int rollback = sqlite3BtreeRollback(tree, SQLITE_OK, 0);
    if (rollback != SQLITE_OK) rc = rollback;
  }
  sqlite3BtreeLeave(tree);
  sqlite3_mutex_leave(sqlite3_db_mutex(recoveryCopyDb));
  return rc == SQLITE_OK ? recoveryCopyCheck() : rc;
}
static int recoveryCopyReply(int rc) {
  if (rc != SQLITE_OK) return emit(driverDb[3], rc, 1, 0, 0);
  const char *names[] = {"done", "pages", "remaining"};
  int values[] = {recoveryCopyDone, recoveryCopyPages, recoveryCopyRemaining};
  for (int i = 0; i < 3 && rc == SQLITE_OK; i++) rc = block(names[i], strlen(names[i]));
  for (int i = 0; i < 3 && rc == SQLITE_OK; i++) {
    unsigned char tag = 1;
    rc = append(&tag, 1);
    if (rc == SQLITE_OK) rc = append64((uint64_t)values[i]);
  }
  return emit(driverDb[3], rc, 1, rc == SQLITE_OK ? 1 : 0, rc == SQLITE_OK ? 3 : 0);
}
static int recoveryCopyRequest(const unsigned char *p, const unsigned char *end) {
  if (p == end) return recoveryCopyReply(SQLITE_MISUSE);
  int rc;
  if (*p == 0) rc = recoveryCopyStart(p, end);
  else if (end - p != 1) rc = SQLITE_MISUSE;
  else if (*p == 1) rc = recoveryCopyStep();
  else if (*p == 2) {
    rc = recoveryCopyFinalize();
    if (rc == SQLITE_OK) rc = recoveryCopyClose();
  } else if (*p == 3) rc = recoveryCopyClose();
  else rc = SQLITE_MISUSE;
  if (rc != SQLITE_OK) {
    int closed = recoveryCopyClose();
    if (closed != SQLITE_OK) rc = closed;
  }
  return recoveryCopyReply(rc);
}
