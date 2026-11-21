/* Internal operation6 bounded blob transport. Operation3 remains WAL promotion. Content coordinates are DATA, never profile,
 * schema or transaction authority. The host must freshly authenticate the real
 * owner/profile and reserve/update the row in this same native writer first.
 * Blob chunks bypass SQL UPDATE triggers; their reserving row mutation must
 * produce the journal event in the enclosing uncommitted transaction. */
static void brc38BlobProtocol(sqlite3_context *context, int count,
                             sqlite3_value **values) {
  (void)count;
  (void)values;
  sqlite3_result_int(context, 2);
}
static int brc38WriteBlob(int slot, const unsigned char *p,
                         const unsigned char *end) {
  static const char *tables[] = {"transactions", "proven_txs", "proven_tx_reqs",
                                "outputs", "commissions"};
  static const char *columns[][3] = {
      {"rawTx", "inputBEEF", "noSendExpiryReclaimRawTx"},
      {"rawTx", "merklePath", NULL},
      {"rawTx", "inputBEEF", NULL},
      {"lockingScript", NULL, NULL},
      {"lockingScript", NULL, NULL}};
  sqlite3 *db = driverDb[slot];
  sqlite3_blob *blob = NULL;
  int rc = SQLITE_MISUSE, protectedWrite = 0;
  driverPosition = DRIVER_HEADER;
  driverBlobReply = 1;
  driverDecodedCharge = 0;
  driverMessage[0] = 0;
  driverRollbackCode = driverReleaseCode = 0;
  /* Slot3 is a readonly wallet view,1 is the owner,2 is the catalog.
   * Only the leased wallet writer0 can accept a bounded blob operation. */
  if (slot != 0 || !db || !driverAdmitted || driverFenced[slot] || driverCandidateComparison ||
      sqlite3_get_autocommit(db) ||
      sqlite3_txn_state(db, "main") != SQLITE_TXN_WRITE) {
    rc = SQLITE_AUTH;
    goto done;
  }
  /* Operation6 bypasses SQL statement admission. Recheck the durable source
   * retirement namespace on this actual kernel before any blob mutation. */
  rc = profileWalletWritable();
  if (rc != SQLITE_OK) goto done;
  if (end - p < 28 || p[0] >= 5 || p[1] >= 3 || p[2] || p[3] ||
      !columns[p[0]][p[1]] || get32(p + 24))
    goto done;
  uint64_t row = get64(p + 4);
  uint32_t offset = get32(p + 12), total = get32(p + 16),
           amount = get32(p + 20);
  if (!row || row > UINT64_C(9007199254740991) || !amount || amount > 65536 ||
      total > 1000000000 || offset > total || amount > total - offset ||
      (size_t)(end - p) != (size_t)28 + amount)
    goto done;
  rc = controlSql(db, "SAVEPOINT __brc38_blob_reply;");
  if (rc != SQLITE_OK)
    goto done;
  protectedWrite = 1;
  driverDeadline = clockMs() + 10000;
  sqlite3_progress_handler(db, 1000, progress, NULL);
  rc = brc38OpenNativeBlob(db, "main", tables[p[0]], columns[p[0]][p[1]],
                         (sqlite3_int64)row, 1, &blob);
  if (rc == SQLITE_OK && sqlite3_blob_bytes(blob) != (int)total)
    rc = SQLITE_ABORT;
  if (rc == SQLITE_OK) {
    if (!driverPrivateStage) driverSourceWriterBlobAttempt = 1;
    rc = sqlite3_blob_write(blob, p + 28, (int)amount, (int)offset);
  }
  if (blob) {
    int closed = sqlite3_blob_close(blob);
    blob = NULL;
    if (rc == SQLITE_OK)
      rc = closed;
  }
done:
  if (db)
    sqlite3_progress_handler(db, 0, NULL, NULL);
  if (rc != SQLITE_OK)
    snprintf(driverMessage, sizeof(driverMessage), "%s", sqlite3_errstr(rc));
  if (protectedWrite) {
    if (rc != SQLITE_OK)
      driverRollbackCode = controlSql(db, "ROLLBACK TO __brc38_blob_reply;");
    if (driverRollbackCode == SQLITE_OK)
      driverReleaseCode = controlSql(db, "RELEASE __brc38_blob_reply;");
    if (driverRollbackCode != SQLITE_OK || driverReleaseCode != SQLITE_OK)
      driverFenced[slot] = 1;
    if (rc == SQLITE_OK && driverReleaseCode != SQLITE_OK)
      rc = driverReleaseCode;
  }
  return emit(db, rc, 0, 0, 0);
}
