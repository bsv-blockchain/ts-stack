/* Operation7: a single <=64KiB extent directly from SQLite's incremental BLOB
 * handle into the already bounded reply buffer. SQL substr can materialize the
 * complete record and is deliberately not used. No caller SQL/path is accepted.
 * The current transaction and kernel/profile lifetime remain independently
 * required; the ABI version is only transport DATA. */
/* Additive v2 raw TEXT coordinates. Binary table/field IDs and v1 structured
 * TEXT IDs are unchanged. These source constants grant no connection lease. */
static const char *brc38ReadTables[] = {
    "transactions", "proven_txs", "proven_tx_reqs", "outputs", "commissions",
    "sync_states", "certificates", "certificate_fields", "prepared_beefs",
    "action_batch_blobs", "sync_transfer_parts", "action_batches",
    "sync_transfers", "monitor_events", "snapshot_reconciliation_stage_pages",
    "snapshot_reconciliation_provenance", "brc38_import_original",
    "brc38_import_streamed_original", "brc38_import_structured_original",
    "private_binary_chunks", "private_text_chunks", "private_structured_chunks",
    "private_canonical_structured_chunks", "private_projected_structured_chunks"};
static const char *brc38ReadColumns[][8] = {
    {"rawTx", "inputBEEF", "noSendExpiryReclaimRawTx", "description",
     "noSendExpiryReclaimDerivationPrefix", "noSendExpiryReclaimDerivationSuffix", NULL, NULL},
    {"rawTx", "merklePath", NULL, NULL, NULL, NULL, NULL, NULL},
    {"rawTx", "inputBEEF", "history", "notify", NULL, NULL, NULL, NULL},
    {"lockingScript", "outputDescription", "spendingDescription", "customInstructions",
     "derivationPrefix", "derivationSuffix", "type", "purpose"},
    {"lockingScript", "keyOffset", NULL, NULL, NULL, NULL, NULL, NULL},
    {"syncMap", "errorLocal", "errorOther", NULL, NULL, NULL, NULL, NULL},
    {"subject", "revocationOutpoint", "signature", "verifier", NULL, NULL, NULL, NULL},
    {"fieldValue", "masterKey", NULL, NULL, NULL, NULL, NULL, NULL},
    {"beef", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"bytes", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"bytes", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"uploadDigests", "result", "manifest", NULL, NULL, NULL, NULL, NULL},
    {"result", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"details", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"payload", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"payload", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"originalJson", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"originalJson", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"originalJson", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"payload", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"payload", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"payload", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"payload", NULL, NULL, NULL, NULL, NULL, NULL, NULL},
    {"payload", NULL, NULL, NULL, NULL, NULL, NULL, NULL}};
static int brc38ReadLocalCoordinate(int table, int field) {
  if (table < 0 || table >= 24 || field < 0 || field >= 8 || !brc38ReadColumns[table][field]) return 0;
  return (table == 0 && field < 3) || ((table == 1 || table == 2) && field < 2) ||
         ((table == 3 || table == 4) && field == 0) || table >= 8;
}
static int brc38ReadTextCoordinate(int table, int field) {
  if (table < 0 || table >= 8 || field < 0 || field >= 8 || !brc38ReadColumns[table][field]) return 0;
  return (table == 0 && field >= 3) || (table == 2 && field >= 2) ||
         ((table == 3 || table == 4) && field >= 1) || table >= 5;
}
static void brc38BlobReadProtocol(sqlite3_context *context, int count,
                                 sqlite3_value **values) {
  (void)count;
  (void)values;
  sqlite3_result_int(context, 1);
}
static void brc38TextReadProtocol(sqlite3_context *context, int count,
                                sqlite3_value **values) {
  (void)count; (void)values;
  sqlite3_result_int(context, 2);
}
static void brc38LocalFieldProtocol(sqlite3_context *context, int count,
                                   sqlite3_value **values) {
  (void)count; (void)values;
  sqlite3_result_int(context, 3);
}
/* TEXT metadata from an incremental handle, not length(CAST(TEXT AS BLOB)),
 * which can force SQLite to materialize the entire record. typeof has the
 * SQLite metadata-only column flag; it distinguishes NULL without cloning the
 * field. Fixed SQL/coordinates only, on this actual retained connection. */
static void brc38FieldExtentBytes(sqlite3_context *context, int count,
                                  sqlite3_value **values, int local) {
  char query[256];
  sqlite3 *db = sqlite3_context_db_handle(context);
  sqlite3_stmt *statement = NULL;
  sqlite3_blob *blob = NULL;
  int slot = -1, family = -1, field = -1, rc = SQLITE_MISUSE, bytes = -1, nullValue = 0;
  sqlite3_int64 row = 0;
  for (int i = 0; i < DRIVER_CONNECTIONS; i++) if (driverDb[i] == db) slot = i;
  if (count != 3 || (slot != 0 && slot != 3) || driverFenced[slot] || sqlite3_get_autocommit(db) ||
      sqlite3_txn_state(db, "main") == SQLITE_TXN_NONE) { rc = SQLITE_AUTH; goto done; }
  for (int i = 0; i < 3; i++) if (sqlite3_value_type(values[i]) != SQLITE_INTEGER) goto done;
  sqlite3_int64 table = sqlite3_value_int64(values[0]), column = sqlite3_value_int64(values[1]);
  row = sqlite3_value_int64(values[2]);
  if (table < 0 || table >= 24 || column < 0 || column >= 8 ||
      !(local ? brc38ReadLocalCoordinate((int)table, (int)column) :
                brc38ReadTextCoordinate((int)table, (int)column))) goto done;
  family = (int)table; field = (int)column;
  int text = !local || (family >= 11 && family <= 13) || (family >= 16 && family <= 18);
  /* Only compile-time whitelist strings enter this SQL, never caller text. */
  int queryBytes = snprintf(query, sizeof(query), "SELECT typeof(\"%s\") FROM \"%s\" WHERE rowid=?",
                            brc38ReadColumns[family][field], brc38ReadTables[family]);
  if (queryBytes < 0 || (size_t)queryBytes >= sizeof(query)) goto done;
  if (row < -INT64_C(9007199254740991) || row > INT64_C(9007199254740991)) goto done;
  if (driverPrivateStage && (rc = privateStageCheck()) != SQLITE_OK) goto done;
  /* The direct bytes must actually be UTF-8, not a database's UTF-16 record
   * relabelled as a UTF-8 portable field. This metadata is checked afresh. */
  rc = text ? sqlite3_prepare_v2(db, "PRAGMA encoding", -1, &statement, NULL) : SQLITE_OK;
  if (rc == SQLITE_OK && text) {
    rc = sqlite3_step(statement);
    if (rc == SQLITE_ROW) {
      const unsigned char *encoding = sqlite3_column_text(statement, 0);
      if (!encoding || strcmp((const char *)encoding, "UTF-8")) { rc = SQLITE_MISMATCH; goto done; }
      rc = sqlite3_step(statement);
      if (rc == SQLITE_DONE) rc = SQLITE_OK;
      else if (rc == SQLITE_ROW) rc = SQLITE_CONSTRAINT;
    } else if (rc == SQLITE_DONE) rc = SQLITE_NOTFOUND;
  }
  if (statement) {
    int closed = sqlite3_finalize(statement); statement = NULL;
    if (rc == SQLITE_OK) rc = closed;
  }
  if (rc != SQLITE_OK) goto done;
  rc = sqlite3_prepare_v2(db, query, -1, &statement, NULL);
  if (rc == SQLITE_OK) rc = sqlite3_bind_int64(statement, 1, row);
  if (rc == SQLITE_OK) {
    rc = sqlite3_step(statement);
    if (rc == SQLITE_ROW) {
      const unsigned char *kind = sqlite3_column_text(statement, 0);
      if (kind && !strcmp((const char *)kind, "null")) nullValue = 1;
      else if (!kind || strcmp((const char *)kind, text ? "text" : "blob")) { rc = SQLITE_MISMATCH; goto done; }
      rc = sqlite3_step(statement);
      if (rc == SQLITE_DONE) rc = SQLITE_OK;
      else if (rc == SQLITE_ROW) rc = SQLITE_CONSTRAINT;
    } else if (rc == SQLITE_DONE) rc = SQLITE_NOTFOUND;
  }
  if (rc == SQLITE_OK && !nullValue) {
    rc = brc38OpenNativeBlob(db, "main", brc38ReadTables[family], brc38ReadColumns[family][field], row, 0, &blob);
    if (rc == SQLITE_OK) {
      bytes = sqlite3_blob_bytes(blob);
      if (bytes < 0 || bytes > 1000000000) rc = SQLITE_TOOBIG;
    }
  }
done:
  if (blob) { int closed = sqlite3_blob_close(blob); if (rc == SQLITE_OK) rc = closed; }
  if (statement) { int closed = sqlite3_finalize(statement); if (rc == SQLITE_OK) rc = closed; }
  if (rc == SQLITE_OK && driverPrivateStage) rc = privateStageCheck();
  if (rc == SQLITE_OK && (slot < 0 || sqlite3_get_autocommit(db) || driverFenced[slot])) rc = SQLITE_ABORT;
  if (rc != SQLITE_OK) { sqlite3_result_error(context, sqlite3_errstr(rc), -1); sqlite3_result_error_code(context, rc); }
  else if (nullValue) sqlite3_result_null(context);
  else sqlite3_result_int(context, bytes);
}
static void brc38TextExtentBytes(sqlite3_context *context, int count,
                                 sqlite3_value **values) {
  brc38FieldExtentBytes(context, count, values, 0);
}
static void brc38LocalFieldExtentBytes(sqlite3_context *context, int count,
                                       sqlite3_value **values) {
  brc38FieldExtentBytes(context, count, values, 1);
}
static int brc38ReadBlob(int slot, const unsigned char *p,
                        const unsigned char *end, int local) {
  sqlite3 *db = driverDb[slot];
  sqlite3_blob *blob = NULL;
  int rc = SQLITE_MISUSE;
  driverPosition = DRIVER_HEADER;
  driverBlobReply = 1;
  driverDecodedCharge = 0;
  if ((slot != 0 && slot != 3) || !db ||
      driverFenced[slot] || sqlite3_get_autocommit(db) ||
      sqlite3_txn_state(db, "main") == SQLITE_TXN_NONE) {
    rc = SQLITE_AUTH;
    goto done;
  }
  if (end - p != 28 || p[0] >= 24 || p[1] >= 8 || p[2] || p[3] ||
      !brc38ReadColumns[p[0]][p[1]] || get32(p + 24) ||
      (local ? !brc38ReadLocalCoordinate(p[0], p[1]) : p[0] >= 8))
    goto done;
  uint64_t encodedRow = get64(p + 4);
  int text = brc38ReadTextCoordinate(p[0], p[1]);
  sqlite3_int64 row;
  /* The separate local operation8 and additive TEXT reads retain signed safe
   * physical rowids. Original operation7 binary validation stays unsigned. */
  if (text || local) {
    if (encodedRow <= UINT64_C(9007199254740991)) row = (sqlite3_int64)encodedRow;
    else if (encodedRow >= UINT64_MAX - UINT64_C(9007199254740991) + 1)
      row = -(sqlite3_int64)(~encodedRow) - 1;
    else goto done;
  } else {
    if (!encodedRow || encodedRow > UINT64_C(9007199254740991)) goto done;
    row = (sqlite3_int64)encodedRow;
  }
  uint32_t offset = get32(p + 12), total = get32(p + 16), amount = get32(p + 20);
  if (!amount || amount > 65536 ||
      !total || total > 1000000000 || offset >= total || amount > total - offset)
    goto done;
  rc = decodedCharge(128 + 64 + 32 + 14 + amount);
  if (rc != SQLITE_OK)
    goto done;
  rc = block("payload", 7);
  unsigned char tag = 4;
  if (rc == SQLITE_OK) rc = append(&tag, 1);
  if (rc == SQLITE_OK) rc = append32(amount);
  if (rc == SQLITE_OK && amount > driverMaximum - driverPosition)
    rc = SQLITE_TOOBIG;
  if (rc != SQLITE_OK)
    goto done;
  driverDeadline = clockMs() + 10000;
  sqlite3_progress_handler(db, 1000, progress, NULL);
  rc = brc38OpenNativeBlob(db, "main", brc38ReadTables[p[0]], brc38ReadColumns[p[0]][p[1]],
                         (sqlite3_int64)row, 0, &blob);
  if (rc == SQLITE_OK && sqlite3_blob_bytes(blob) != (int)total)
    rc = SQLITE_ABORT;
  if (rc == SQLITE_OK)
    rc = sqlite3_blob_read(blob, driverOutput + driverPosition,
                           (int)amount, (int)offset);
  if (rc == SQLITE_OK) driverPosition += amount;
done:
  if (blob) {
    int closed = sqlite3_blob_close(blob);
    if (rc == SQLITE_OK) rc = closed;
  }
  if (db) sqlite3_progress_handler(db, 0, NULL, NULL);
  if (rc == SQLITE_OK && driverPrivateStage) rc = privateStageCheck();
  if (rc == SQLITE_OK && (sqlite3_get_autocommit(db) || driverFenced[slot]))
    rc = SQLITE_ABORT;
  if (rc != SQLITE_OK)
    snprintf(driverMessage, sizeof(driverMessage), "%s", sqlite3_errstr(rc));
  return emit(db, rc, 1, rc == SQLITE_OK ? 1 : 0, rc == SQLITE_OK ? 1 : 0);
}
