/* Internal stage transport owns the existing two physical families and actual
 * kernel owner lock. Matching descriptors/digests or this framing check never
 * substitute for complete authenticated source/semantic/receiver admission. */
static void brc38PrivateStageProtocol(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_int(context, 1);
}
static uint64_t privateStageWallMs(void) {
#if SQLITE_OS_WIN
  FILETIME wall;
  GetSystemTimeAsFileTime(&wall);
  uint64_t ticks = ((uint64_t)wall.dwHighDateTime << 32) | wall.dwLowDateTime;
  if (ticks < UINT64_C(116444736000000000)) return UINT64_MAX;
  return (ticks - UINT64_C(116444736000000000)) / 10000;
#else
  struct timespec now;
  if (clock_gettime(CLOCK_REALTIME, &now) || now.tv_sec < 0)
    return UINT64_MAX;
  return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
#endif
}
static int privateStageCount(sqlite3 *db, const char *text, int owner) {
  sqlite3_stmt *s = NULL;
  driverDeadline = clockMs() + 10000;
  sqlite3_progress_handler(db, 1000, progress, NULL);
  int rc = sqlite3_prepare_v2(db, text, -1, &s, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_bind_text(s, 1, driverStageBinding, 64, SQLITE_STATIC);
  if (rc == SQLITE_OK)
    rc = sqlite3_bind_int64(s, 2, owner ? (sqlite3_int64)driverStageExpiry
                                      : (sqlite3_int64)(driverMaximum - 65536));
  if (rc == SQLITE_OK) {
    rc = sqlite3_step(s);
    if (rc == SQLITE_ROW && sqlite3_column_type(s, 0) == SQLITE_INTEGER &&
        sqlite3_column_int64(s, 0) == 1)
      rc = sqlite3_step(s) == SQLITE_DONE ? SQLITE_OK : SQLITE_AUTH;
    else if (rc == SQLITE_ROW || rc == SQLITE_DONE)
      rc = SQLITE_AUTH;
  }
  int finalized = sqlite3_finalize(s);
  sqlite3_progress_handler(db, 0, NULL, NULL);
  return rc == SQLITE_OK ? finalized : rc;
}
static int privateStageCheck(void) {
  if (!driverPrivateStage || privateStageWallMs() >= driverStageExpiry ||
      clockMs() >= driverStageDeadline || !driverDb[1] ||
      sqlite3_get_autocommit(driverDb[1]) ||
      sqlite3_txn_state(driverDb[1], "main") != SQLITE_TXN_WRITE)
    return SQLITE_AUTH;
  int rc = brc38Directory(&driverQuota);
  if (rc != SQLITE_OK)
    return rc;
  return privateStageCount(driverDb[1], driverRecoveryStage ?
      "SELECT count(*) FROM owner WHERE slot=1 AND "
      "protocol='brc38-recovery-owner/v1' AND binding=?1 AND expiresAt=?2" :
      "SELECT count(*) FROM owner WHERE slot=1 AND "
      "protocol='brc38-private-owner/v1' AND binding=?1 AND expiresAt=?2", 1);
}
static int privateStageAdmit(void) {
  int rc = privateStageCheck();
  if (rc != SQLITE_OK || !driverDb[0])
    return rc == SQLITE_OK ? SQLITE_AUTH : rc;
  return privateStageCount(driverDb[0],
      "SELECT count(*) FROM metadata AS m "
      "JOIN private_binding AS b ON b.slot=m.slot "
      "JOIN private_import AS i ON i.slot=m.slot "
      "WHERE m.slot=1 AND m.state='sealed' AND m.header IS NOT NULL "
      "AND length(CAST(m.header AS BLOB)) BETWEEN 1 AND ?2 "
      "AND b.protocol='brc38-resumable-private/v1' AND b.digest=?1 "
      "AND length(CAST(b.bindingJson AS BLOB)) BETWEEN 1 AND 4096 "
      "AND length(CAST(b.limitsJson AS BLOB)) BETWEEN 1 AND 256 "
      "AND length(CAST(i.archiveSha256 AS BLOB))=64", 0);
}

/* A NEW copied scratch family has an empty owner file. This creates its own
 * owner metadata under the actual retained kernel writer. It never opens or
 * updates the expired reservation's owner file. Original expiry is DATA and
 * must remain distinct from this finite comparison lifetime. */
static int recoveryStageInitializeOwner(void) {
  if (!driverRecoveryStage || !driverDb[1] || sqlite3_get_autocommit(driverDb[1]) ||
      sqlite3_txn_state(driverDb[1], "main") != SQLITE_TXN_WRITE) return SQLITE_AUTH;
  char sql[512];
  int length = snprintf(sql, sizeof(sql),
    "CREATE TABLE owner(slot INTEGER PRIMARY KEY CHECK(slot=1),protocol TEXT NOT NULL,"
    "binding TEXT NOT NULL,expiresAt INTEGER NOT NULL,originalExpiresAt INTEGER NOT NULL);"
    "INSERT INTO owner VALUES(1,'brc38-recovery-owner/v1','%s',%llu,%llu);",
    driverStageBinding, (unsigned long long)driverStageExpiry,
    (unsigned long long)driverOriginalStageExpiry);
  if (length < 1 || length >= (int)sizeof(sql)) return SQLITE_MISUSE;
  return controlSql(driverDb[1], sql);
}
