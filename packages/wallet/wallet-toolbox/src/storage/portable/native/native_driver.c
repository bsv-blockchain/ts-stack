/* Private ordinary isolated SQLite driver prototype. Internal framing only:
 * no BRC wire change, public capability or full production qualification.
 * The parent must verify the original receipt before wallet promotion. */
#if defined(_WIN32)
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#include "sqlite3.c"
#include "brc38_quota.c"
#include "brc38_runtime.c"
#include <io.h>
#include <fcntl.h>
#define STDIN_FILENO 0
#define STDOUT_FILENO 1
#else
#define main brc38LegacyMain
#include "native_contract.c"
#undef main
#include "profile_contract.c"
#endif
#include <float.h>
#include <stdint.h>
#include <time.h>
_Static_assert(sizeof(double) == 8 && DBL_MANT_DIG == 53,
               "IEEE binary64 required");
#define DRIVER_CONNECTIONS 4
#define DRIVER_SQL_MAX 65536
#define DRIVER_HEADER 34
static Brc38Quota driverQuota;
static sqlite3 *driverDb[DRIVER_CONNECTIONS];
static unsigned char *driverInput, *driverOutput;
static size_t driverMaximum, driverPosition;
static uint64_t driverDecodedMaximum, driverDecodedCharge;
static int driverAdmitted, driverPromoted, driverControl, driverInternal, driverFamily;
static int driverReadJournalMode;
static int driverBeginControl;
static int driverRetiredRead;
static int driverSourceRetirementFrozen, driverSourceWriterBegin, driverSourceWriterBlobAttempt;
static sqlite3_int64 driverSourceWriterChanges;
static int driverBlobReply;
static int driverFenced[DRIVER_CONNECTIONS];
static int driverRollbackCode, driverReleaseCode;
static char driverMessage[513];
static uint32_t driverId;
static uint64_t driverDeadline;
static int driverPrivateStage;
static int driverRecoveryStage;
static uint64_t driverOriginalStageExpiry;
static int driverCandidateComparison;
static uint64_t driverStageExpiry, driverStageDeadline;
static char driverStageBinding[65];
static void brc38PrivateStageProtocol(sqlite3_context *context, int argc, sqlite3_value **argv);
static unsigned char driverSql[DRIVER_SQL_MAX + 1];
static uint64_t clockMs(void) {
#if SQLITE_OS_WIN
  /* GetTickCount64 is monotonic and unaffected by wall-clock changes. */
  return (uint64_t)GetTickCount64();
#else
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) return UINT64_MAX;
  return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
#endif
}
static int progress(void *ignored) {
  (void)ignored;
  return clockMs() >= driverDeadline ||
         (driverPrivateStage && clockMs() >= driverStageDeadline);
}
/* Pure DATA only: the same logical charge as the authored SQL expression.
 * Native trigger storage need not repeat a CAST/length expression per cell.
 * No profile admission, quota enlargement or write capability is granted. */
static void brc38SharedRowCharge(sqlite3_context *context, int argc,
                                 sqlite3_value **argv) {
  if (argc < 1 || argc > 32) {
    sqlite3_result_error_code(context, SQLITE_MISUSE);
    return;
  }
  sqlite3_int64 charge = 4096;
  for (int i = 0; i < argc; i++) {
    if (sqlite3_value_type(argv[i]) == SQLITE_NULL) continue;
    const void *bytes = sqlite3_value_blob(argv[i]);
    int count = sqlite3_value_bytes(argv[i]);
    if ((count > 0 && !bytes) ||
        sqlite3_errcode(sqlite3_context_db_handle(context)) == SQLITE_NOMEM) {
      sqlite3_result_error_nomem(context);
      return;
    }
    /* At most32 signed-int byte counts cannot overflow signed64. */
    charge += (sqlite3_int64)count * 4;
  }
  sqlite3_result_int64(context, charge);
}
/* Pure DATA comparison, matching the original ordered OR of
 * CAST(old AS BLOB) IS NOT CAST(new AS BLOB). NULL is distinct from an
 * empty non-NULL cell. Conversion failure never becomes equality. */
static void brc38CellsChanged(sqlite3_context *context, int argc,
                              sqlite3_value **argv) {
  sqlite3 *db = sqlite3_context_db_handle(context);
  if (argc < 2 || (argc & 1) ||
      argc > sqlite3_limit(db, SQLITE_LIMIT_FUNCTION_ARG, -1)) {
    sqlite3_result_error_code(context, SQLITE_MISUSE);
    return;
  }
  for (int i = 0; i < argc; i += 2) {
    int leftNull = sqlite3_value_type(argv[i]) == SQLITE_NULL;
    int rightNull = sqlite3_value_type(argv[i + 1]) == SQLITE_NULL;
    if (leftNull || rightNull) {
      if (leftNull != rightNull) { sqlite3_result_int(context, 1); return; }
      continue;
    }
    const void *left = sqlite3_value_blob(argv[i]);
    int leftBytes = sqlite3_value_bytes(argv[i]);
    if ((leftBytes > 0 && !left) || sqlite3_errcode(db) == SQLITE_NOMEM) {
      sqlite3_result_error_nomem(context);
      return;
    }
    const void *right = sqlite3_value_blob(argv[i + 1]);
    int rightBytes = sqlite3_value_bytes(argv[i + 1]);
    if ((rightBytes > 0 && !right) || sqlite3_errcode(db) == SQLITE_NOMEM) {
      sqlite3_result_error_nomem(context);
      return;
    }
    if (leftBytes != rightBytes ||
        (leftBytes > 0 && memcmp(left, right, (size_t)leftBytes))) {
      sqlite3_result_int(context, 1);
      return;
    }
  }
  sqlite3_result_int(context, 0);
}
static void brc38CellChangeProtocol(sqlite3_context *context, int argc,
                                   sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_text(context, "brc38-cell-change/v1", -1, SQLITE_STATIC);
}
static int brc38RegisterCellComparison(sqlite3 *db) {
  int flags = SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS;
  int rc = sqlite3_create_function_v2(db, "brc38_cells_changed", -1, flags,
                                     NULL, brc38CellsChanged, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_cell_change_protocol", 0, flags,
                                    NULL, brc38CellChangeProtocol, NULL, NULL, NULL);
  return rc;
}
/* Pure arithmetic for the same guarded atomic quota update. Keep the complete
 * counter predicate out of every stored trigger, without enlarging a limit or
 * holding database state in the function. Corrupt counters refuse the statement.
 * Subtract before adding so malformed signed64 inputs cannot overflow. */
static void brc38SharedQuotaNextBytes(sqlite3_context *context, int argc,
                                      sqlite3_value **argv) {
  sqlite3_int64 value[8];
  if (argc != 8) goto refused;
  for (int i = 0; i < 8; i++) {
    if (sqlite3_value_type(argv[i]) != SQLITE_INTEGER) goto refused;
    value[i] = sqlite3_value_int64(argv[i]);
  }
  sqlite3_int64 bytes = value[0], rows = value[1], bit = value[2];
  sqlite3_int64 byteLimit = value[3], rowLimit = value[4];
  sqlite3_int64 before = value[5], after = value[6], delta = value[7];
  if ((bit != 0 && bit != 1) || byteLimit != INT64_C(17179869184) ||
      rowLimit != INT64_C(2147483647) || before < 0 || after < 0 ||
      delta < -1 || delta > 1 || bytes < before || after > byteLimit ||
      bytes - before > byteLimit - after || rows < (delta < 0 ? 1 : 0) ||
      rows > rowLimit - delta) goto refused;
  sqlite3_result_int64(context, bytes - before + after);
  return;
refused:
  sqlite3_result_error(context, "Shared journal quota exhausted or inconsistent", -1);
  sqlite3_result_error_code(context, SQLITE_CONSTRAINT_TRIGGER);
}
static uint32_t get32(const unsigned char *b) {
  return (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 |
         (uint32_t)b[3] << 24;
}
static uint64_t get64(const unsigned char *b) {
  return get32(b) | (uint64_t)get32(b + 4) << 32;
}
static void set32(unsigned char *b, uint32_t v) {
  for (int i = 0; i < 4; i++)
    b[i] = (unsigned char)(v >> (i * 8));
}
static void set64(unsigned char *b, uint64_t v) {
  set32(b, (uint32_t)v);
  set32(b + 4, (uint32_t)(v >> 32));
}
static int append(const void *bytes, size_t amount) {
  if (amount > driverMaximum - driverPosition)
    return SQLITE_TOOBIG;
  if (amount)
    memcpy(driverOutput + driverPosition, bytes, amount);
  driverPosition += amount;
  return SQLITE_OK;
}
static int append32(uint32_t value) {
  unsigned char b[4];
  set32(b, value);
  return append(b, 4);
}
static int append64(uint64_t value) {
  unsigned char b[8];
  set64(b, value);
  return append(b, 8);
}
static int block(const void *bytes, size_t amount) {
  if (amount > UINT32_MAX)
    return SQLITE_TOOBIG;
  int rc = append32((uint32_t)amount);
  return rc == SQLITE_OK ? append(bytes, amount) : rc;
}
static int exactRead(int fd, void *buffer, size_t amount, int cleanEof) {
  unsigned char *b = buffer;
  size_t at = 0;
  while (at < amount) {
#if SQLITE_OS_WIN
    int n = _read(fd, b + at, (unsigned int)(amount - at));
#else
    ssize_t n = read(fd, b + at, amount - at);
#endif
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0)
      return n == 0 && at == 0 && cleanEof ? 0 : -1;
    at += (size_t)n;
  }
  return 1;
}
static int exactWrite(int fd, const void *buffer, size_t amount) {
  const unsigned char *b = buffer;
  size_t at = 0;
  while (at < amount) {
#if SQLITE_OS_WIN
    int n = _write(fd, b + at, (unsigned int)(amount - at));
#else
    ssize_t n = write(fd, b + at, amount - at);
#endif
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0)
      return -1;
    at += (size_t)n;
  }
  return 0;
}
static int emit(sqlite3 *db, int rc, int reader, uint32_t rows,
                uint16_t columns) {
  set32(driverOutput, driverId);
  set32(driverOutput + 4, (uint32_t)rc);
  driverOutput[8] = (unsigned char)reader;
  driverOutput[9] = (unsigned char)(db ? sqlite3_get_autocommit(db) : 1);
  driverOutput[10] =
      (unsigned char)(db && driverFenced[driverFamily == 0
                                             ? (db == driverDb[3] ? 3 : 0)
                                             : driverFamily]);
  driverOutput[11] = 0;
  set64(driverOutput + 12, (uint64_t)(db && !driverBlobReply ? sqlite3_changes64(db) : 0));
  set64(driverOutput + 20, (uint64_t)(db && !driverBlobReply ? sqlite3_last_insert_rowid(db) : 0));
  driverOutput[28] = (unsigned char)columns;
  driverOutput[29] = (unsigned char)(columns >> 8);
  set32(driverOutput + 30, rows);
  if (rc != SQLITE_OK) {
    driverPosition = DRIVER_HEADER;
    const char *message = driverMessage[0]
                              ? driverMessage
                              : (db ? sqlite3_errmsg(db) : sqlite3_errstr(rc));
    size_t length = strnlen(message, 512);
    if (block(message, length) != SQLITE_OK ||
        append32((uint32_t)driverRollbackCode) != SQLITE_OK ||
        append32((uint32_t)driverReleaseCode) != SQLITE_OK)
      return -1;
  }
  unsigned char header[4];
  set32(header, (uint32_t)driverPosition);
  return exactWrite(STDOUT_FILENO, header, 4) ||
                 exactWrite(STDOUT_FILENO, driverOutput, driverPosition)
             ? -1
             : 0;
}
static int originalCatalogInsert(sqlite3 *db, const char *table) {
  if (!db) return SQLITE_AUTH;
  int internal = driverInternal;
  driverInternal = 1;
  sqlite3_stmt *statement = NULL;
  int rc = sqlite3_prepare_v3(db, !sqlite3_stricmp(table, "profile_retired")
    ? "SELECT slot FROM profile_retired LIMIT 1" : "SELECT slot FROM profile_original LIMIT 1",
    -1, 0, &statement, NULL);
  if (rc == SQLITE_OK) rc = sqlite3_step(statement) == SQLITE_DONE ? SQLITE_OK : SQLITE_AUTH;
  int finalized = sqlite3_finalize(statement);
  driverInternal = internal;
  return rc == SQLITE_OK ? finalized : rc;
}
/* Fresh exact source comparison for the rowless v3 observer dispatch view.
 * Direct SQL and counterfeit observers cannot manufacture a local event.
 * This is checked on this connection's current schema at preparation, never a
 * saved owner/schema verdict. The view retains the original SQL guards. */
static int localBaselineEventSource(sqlite3 *db, const char *trigger) {
  if (!db || db != driverDb[0] || !trigger || driverFamily != 0 ||
      driverRetiredRead || driverCandidateComparison) return SQLITE_AUTH;
  static const char *tables[] = {
    "users", "settings", "proven_txs", "proven_tx_reqs", "output_baskets",
    "output_tags", "tx_labels", "transactions", "outputs", "commissions",
    "tx_labels_map", "output_tags_map", "certificates", "certificate_fields",
    "sync_states", "monitor_events", "prepared_beef_metadata", "prepared_beefs",
    "action_batches", "action_batch_outputs", "action_batch_blobs", "sync_transfers",
    "sync_transfer_parts", "auth_sessions", "auth_message_nonces", "payment_replays",
    "snapshot_sync_sessions", "snapshot_sync_ids", "snapshot_sync_primary_epochs",
    "snapshot_reconciliation_windows", "snapshot_reconciliation_stage_budgets",
    "snapshot_reconciliation_stage_pages", "snapshot_reconciliation_stage_chains",
    "snapshot_reconciliation_promotion_cursors", "snapshot_reconciliation_captured_identity_budgets",
    "snapshot_reconciliation_captured_identities", "snapshot_reconciliation_identity_frames",
    "snapshot_reconciliation_identity_budgets", "snapshot_reconciliation_identity_maps",
    "snapshot_reconciliation_identity_retirement_budgets", "snapshot_reconciliation_identity_retirements",
    "snapshot_reconciliation_membership_budgets", "snapshot_reconciliation_memberships",
    "snapshot_reconciliation_membership_retirements", "snapshot_reconciliation_provenance_budgets",
    "snapshot_reconciliation_provenance", "snapshot_reconciliation_window_progress"
  };
  _Static_assert(sizeof(tables) / sizeof(tables[0]) == 47, "original local table inventory");
  const char *events[] = {"INSERT", "DELETE", "UPDATE"};
  const char *suffixes[] = {"insert", "delete", "update"};
  char name[192], sql[1536], projected[1536] = "";
  const char *sourceTable = NULL;
  int grouped = 0, compactObserverName = 0;
  for (size_t table = 0; table < sizeof(tables) / sizeof(tables[0]) && !sourceTable; table++)
    for (size_t event = 0; event < 3; event++) {
      int amount = snprintf(name, sizeof(name), "brc38_local_baseline_%s_%s", tables[table], suffixes[event]);
      if (amount < 0 || (size_t)amount >= sizeof(name)) return SQLITE_TOOBIG;
      if (strcmp(name, trigger)) {
        amount = snprintf(name, sizeof(name), "brc38_local_baseline_s%zu_%s", table, suffixes[event]);
        if (amount < 0 || (size_t)amount >= sizeof(name)) return SQLITE_TOOBIG;
        if (strcmp(name, trigger)) continue;
        compactObserverName = 1;
      }
      amount = snprintf(sql, sizeof(sql),
        "CREATE TRIGGER %s AFTER %s ON %s BEGIN INSERT INTO brc38_local_baseline_event"
        "(tableId,oldRowId,newRowId,present) VALUES(%zu,%s,%s,%d); END",
        name, events[event], tables[table], table, event == 0 ? "NULL" : "OLD.rowid",
        event == 1 ? "NULL" : "NEW.rowid", event == 1 ? 0 : 1);
      if (amount < 0 || (size_t)amount >= sizeof(sql)) return SQLITE_TOOBIG;
      sourceTable = tables[table];
      break;
    }
  static const struct { const char *family; int id, table; const char *key; } pointers[] = {
    {"binary",0,7,"transactionId"}, {"binary",1,2,"provenTxId"}, {"binary",2,3,"provenTxReqId"},
    {"binary",3,8,"outputId"}, {"binary",4,9,"commissionId"}, {"binary",8,17,"preparedBeefId"},
    {"binary",9,20,"actionBatchBlobId"}, {"binary",10,22,"rowid"}, {"binary",14,31,"rowid"},
    {"binary",15,45,"rowid"}, {"text",0,7,"transactionId"}, {"text",2,3,"provenTxReqId"},
    {"text",3,8,"outputId"}, {"text",4,9,"commissionId"}, {"text",5,14,"syncStateId"},
    {"text",6,12,"certificateId"}, {"text",7,13,"rowid"}, {"text",11,18,"actionBatchId"},
    {"text",12,21,"slot"}, {"text",13,15,"id"}
  };
  char pointerTable[64];
  for (size_t point = 0; point < sizeof(pointers) / sizeof(pointers[0]) && !sourceTable; point++)
    for (size_t event = 0; event < 2; event++) {
      int amount = snprintf(name, sizeof(name), "brc38_local_baseline_packed_%s_%d_%s",
        pointers[point].family, pointers[point].id, events[event]);
      if (amount < 0 || (size_t)amount >= sizeof(name)) return SQLITE_TOOBIG;
      if (strcmp(name, trigger)) continue;
      amount = snprintf(pointerTable, sizeof(pointerTable), "brc38_native_%s_fields", pointers[point].family);
      if (amount < 0 || (size_t)amount >= sizeof(pointerTable)) return SQLITE_TOOBIG;
      const char *context = event == 0 ? "NEW" : "OLD", *table = tables[pointers[point].table];
      amount = snprintf(sql, sizeof(sql),
        "CREATE TRIGGER %s AFTER %s ON %s WHEN %s.tableId=%d AND EXISTS(SELECT 1 FROM %s s WHERE s.%s=%s.rowId) "
        "BEGIN INSERT INTO brc38_local_baseline_event(tableId,oldRowId,newRowId,present) "
        "VALUES(%d,NULL,(SELECT s.rowid FROM %s s WHERE s.%s=%s.rowId),1); END",
        name, events[event], pointerTable, context, pointers[point].id, table, pointers[point].key,
        context, pointers[point].table, table, pointers[point].key, context);
      if (amount < 0 || (size_t)amount >= sizeof(sql)) return SQLITE_TOOBIG;
      /* One current-parent point query emits the same physical coordinate.
       * LIMIT 1 retains the scalar lookup; absent parents emit no event. Only
       * this fixed source/id/context spelling is added to the exact match. */
      amount = snprintf(projected, sizeof(projected),
        "CREATE TRIGGER %s AFTER %s ON %s WHEN %s.tableId=%d "
        "BEGIN INSERT INTO brc38_local_baseline_event SELECT %d,NULL,s.rowid,1 "
        "FROM %s s WHERE s.%s=%s.rowId LIMIT 1; END",
        name, events[event], pointerTable, context, pointers[point].id,
        pointers[point].table, table, pointers[point].key, context);
      if (amount < 0 || (size_t)amount >= sizeof(projected)) return SQLITE_TOOBIG;
      sourceTable = pointerTable;
      break;
    }
  /* Fresh grouped observers retain the same twenty fixed coordinates. The
   * single active tableId selects one parent; the compound LIMIT1 preserves
   * missing-parent and physical-rowid behavior. Both complete base/local
   * spellings are fixed DATA, then checked against this current main schema. */
  for (int family = 0; family < 2 && !sourceTable; family++)
    for (int event = 0; event < 2; event++) {
      const char *kind = family ? "text" : "binary", *context = event ? "OLD" : "NEW";
      int amount = snprintf(name, sizeof(name), "brc38_local_baseline_packed_%s_%s", kind, events[event]);
      if (amount < 0 || (size_t)amount >= sizeof(name)) return SQLITE_TOOBIG;
      if (strcmp(name, trigger)) continue;
      amount = snprintf(pointerTable, sizeof(pointerTable), "brc38_native_%s_fields", kind);
      if (amount < 0 || (size_t)amount >= sizeof(pointerTable)) return SQLITE_TOOBIG;
      for (int local = 0; local < 2; local++) {
        char *definition = local ? projected : sql;
        size_t used = 0; int branches = 0;
        amount = snprintf(definition, sizeof(sql),
          "CREATE TRIGGER %s AFTER %s ON %s BEGIN INSERT INTO brc38_local_baseline_event ",
          name, events[event], pointerTable);
        if (amount < 0 || (size_t)amount >= sizeof(sql)) return SQLITE_TOOBIG;
        used = (size_t)amount;
        for (size_t point = 0; point < sizeof(pointers) / sizeof(pointers[0]); point++) {
          if (strcmp(pointers[point].family, kind) || (!local && pointers[point].id >= 8)) continue;
          amount = snprintf(definition + used, sizeof(sql) - used,
            "%sSELECT %d,NULL,s.rowid,1 FROM %s s WHERE %s.tableId=%d AND s.%s=%s.rowId",
            branches++ ? " UNION ALL " : "", pointers[point].table, tables[pointers[point].table],
            context, pointers[point].id, pointers[point].key, context);
          if (amount < 0 || (size_t)amount >= sizeof(sql) - used) return SQLITE_TOOBIG;
          used += (size_t)amount;
        }
        amount = snprintf(definition + used, sizeof(sql) - used, " LIMIT 1; END");
        if (amount < 0 || (size_t)amount >= sizeof(sql) - used) return SQLITE_TOOBIG;
      }
      grouped = 1;
      sourceTable = pointerTable;
      break;
    }
  if (!sourceTable) return SQLITE_AUTH;
  /* Both occupied named-column emitters and fresh positional emitters are
   * canonical. Derive only this fixed spelling change in bounded storage;
   * all coordinates, parent names and conditions still compare byte-exact. */
  static const char columns[] = "(tableId,oldRowId,newRowId,present)";
  const char *position = strstr(sql, columns);
  char compact[sizeof(sql)];
  if (!position) {
    if (!grouped) return SQLITE_AUTH;
    memcpy(compact, sql, strlen(sql) + 1);
  } else {
    size_t prefix = (size_t)(position - sql), tail = strlen(position + sizeof(columns) - 1);
    if (prefix + tail + 1 > sizeof(compact)) return SQLITE_TOOBIG;
    memcpy(compact, sql, prefix);
    memcpy(compact + prefix, position + sizeof(columns) - 1, tail + 1);
  }
  /* A compact source name belongs only to the fresh positional family. The
   * occupied named-column form remains valid under its original full name. */
  if (compactObserverName) sql[0] = 0;
  sqlite3_stmt *statement = NULL;
  int internal = driverInternal;
  driverInternal = 1;
  int rc = sqlite3_prepare_v2(db,
    "SELECT count(*) FROM main.sqlite_schema WHERE type='trigger' AND name=?1 AND tbl_name=?2 AND (sql=?3 OR sql=?4 OR sql=?5) "
    "AND NOT EXISTS(SELECT 1 FROM temp.sqlite_schema WHERE name=?1 COLLATE NOCASE)",
    -1, &statement, NULL);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 1, trigger, -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 2, sourceTable, -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 3, sql, -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 4, compact, -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 5, projected, -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_step(statement) == SQLITE_ROW &&
    sqlite3_column_int(statement, 0) == 1 ? SQLITE_OK : SQLITE_AUTH;
  int finalized = sqlite3_finalize(statement);
  driverInternal = internal;
  return rc == SQLITE_OK ? finalized : rc;
}
#include "shared_quota_sources.h"
_Static_assert(sizeof(brc38QuotaSources) / sizeof(brc38QuotaSources[0]) == 18,
               "original shared quota sources");
_Static_assert(sizeof(brc38QuotaEmitters) / sizeof(brc38QuotaEmitters[0]) == 54,
               "original shared quota events");
/* The dispatch carries numeric charges only. Its caller must be an exact
 * installed emitter on its exact compiled source table, with the exact rowless
 * view/consumer. Read all four complete definitions on this actual connection
 * at preparation; no saved source/owner/schema verdict is reused. */
static int sharedQuotaEventSource(sqlite3 *db, const char *trigger) {
  if (!db || db != driverDb[0] || !trigger || driverFamily != 0 ||
      driverRetiredRead || driverCandidateComparison) return SQLITE_AUTH;
  size_t emitter = sizeof(brc38QuotaEmitters) / sizeof(brc38QuotaEmitters[0]);
  for (size_t i = 0; i < sizeof(brc38QuotaEmitters) / sizeof(brc38QuotaEmitters[0]); i++)
    if (!strcmp(trigger, brc38QuotaEmitters[i].name)) { emitter = i; break; }
  if (emitter == sizeof(brc38QuotaEmitters) / sizeof(brc38QuotaEmitters[0])) return SQLITE_AUTH;
  const char *table = brc38QuotaEmitters[emitter].table, *tableSql = NULL;
  for (size_t i = 0; i < sizeof(brc38QuotaSources) / sizeof(brc38QuotaSources[0]); i++)
    if (!strcmp(table, brc38QuotaSources[i].table)) { tableSql = brc38QuotaSources[i].sql; break; }
  if (!tableSql) return SQLITE_AUTH;
  sqlite3_stmt *statement = NULL;
  int internal = driverInternal;
  driverInternal = 1;
  int rc = sqlite3_prepare_v2(db,
    "SELECT count(*) FROM main.sqlite_schema WHERE ("
    "(type='trigger' AND name=?1 AND tbl_name=?2 AND sql=?3) OR "
    "(type='table' AND name=?2 AND tbl_name=?2 AND sql=?4) OR "
    "(type='view' AND name='snapshot_reconciliation_quota_event' AND sql=?5) OR "
    "(type='trigger' AND name='snapshot_reconciliation_quota_event_apply' AND "
    "tbl_name='snapshot_reconciliation_quota_event' AND sql=?6)) "
    "AND NOT EXISTS(SELECT 1 FROM temp.sqlite_schema WHERE type='trigger' AND name=?1 COLLATE NOCASE)",
    -1, &statement, NULL);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 1, trigger, -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 2, table, -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 3, brc38QuotaEmitters[emitter].sql, -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 4, tableSql, -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 5, brc38QuotaDispatchDefinitions[0], -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_bind_text(statement, 6, brc38QuotaDispatchDefinitions[1], -1, SQLITE_TRANSIENT);
  if (rc == SQLITE_OK) rc = sqlite3_step(statement) == SQLITE_ROW &&
    sqlite3_column_int(statement, 0) == 4 ? SQLITE_OK : SQLITE_AUTH;
  int finalized = sqlite3_finalize(statement);
  driverInternal = internal;
  return rc == SQLITE_OK ? finalized : rc;
}
static int authorization(void *connection, int action, const char *a,
                         const char *b, const char *db, const char *trigger) {
  if (action == SQLITE_INSERT && a && !sqlite3_stricmp(a, "snapshot_reconciliation_quota_event"))
    return db && !strcmp(db, "main") && sharedQuotaEventSource(connection, trigger) == SQLITE_OK
      ? SQLITE_OK : SQLITE_DENY;
  if (action == SQLITE_INSERT && a && !sqlite3_stricmp(a, "brc38_local_baseline_event"))
    return db && !strcmp(db, "main") && localBaselineEventSource(connection, trigger) == SQLITE_OK
      ? SQLITE_OK : SQLITE_DENY;
  /* An explicit retired-source recovery process owns the original physical
   * files but never admits wallet/catalog writes or opens a Root0 writer. */
  if (driverRetiredRead && !driverInternal) {
    switch (action) {
      case SQLITE_SELECT: case SQLITE_READ: case SQLITE_FUNCTION:
      case SQLITE_TRANSACTION: case SQLITE_SAVEPOINT: case SQLITE_RECURSIVE:
        break;
      case SQLITE_PRAGMA: {
        const char *inspection[] = {"table_info", "table_xinfo", "index_info", "index_xinfo",
          "index_list", "foreign_key_list", "foreign_key_check"};
        int accepted = !b;
        for (size_t i = 0; a && i < sizeof(inspection) / sizeof(inspection[0]); i++)
          accepted |= !sqlite3_stricmp(a, inspection[i]);
        if (!accepted) return SQLITE_DENY;
        break;
      }
      default: return SQLITE_DENY;
    }
  }
  /* Actual private-kernel lifecycle phase, not a semantic verdict. The final
   * comparison may prepare/retire bounded scratch content, but cannot change
   * wallet rows, pointers, authenticated source, IDs, custody, schema or clocks.
   * No command returns this owner to mutable import mode. */
  if (driverPrivateStage && driverCandidateComparison && !driverInternal) {
    switch (action) {
      case SQLITE_SELECT: case SQLITE_READ: case SQLITE_FUNCTION:
      case SQLITE_TRANSACTION: case SQLITE_SAVEPOINT: case SQLITE_RECURSIVE:
        break;
      case SQLITE_INSERT: case SQLITE_UPDATE: case SQLITE_DELETE: {
        const char *scratch[] = {"brc38_native_binary_budget", "brc38_native_binary_versions",
          "brc38_native_binary_chunks", "brc38_native_binary_garbage", "brc38_native_text_versions",
          "brc38_native_text_chunks", "brc38_native_text_garbage", "brc38_native_prepared_fields"};
        /* Collection fairness is scratch progress, not wallet authority. Its
         * existing SQL guards permit only alternation of the original row.
         * Never admit replacement, retirement, slot changes or trigger writes. */
        int accepted = action == SQLITE_UPDATE && a && b && db && !trigger &&
          !strcmp(db, "main") && !sqlite3_stricmp(a, "brc38_native_text_gc_progress") &&
          !sqlite3_stricmp(b, "nextFamily");
        for (size_t i = 0; a && i < sizeof(scratch) / sizeof(scratch[0]); i++)
          accepted |= !sqlite3_stricmp(a, scratch[i]);
        if (!accepted) return SQLITE_DENY;
        break;
      }
      case SQLITE_PRAGMA: {
        const char *inspection[] = {"table_info", "table_xinfo", "index_info", "index_xinfo",
          "index_list", "foreign_key_list", "foreign_key_check"};
        int accepted = !b;
        for (size_t i = 0; a && i < sizeof(inspection) / sizeof(inspection[0]); i++)
          accepted |= !sqlite3_stricmp(a, inspection[i]);
        if (!accepted) return SQLITE_DENY;
        break;
      }
      default: return SQLITE_DENY;
    }
  }
  /* A source retirement is forward-only. Its immutable catalog namespace
   * remains after process exit and must not be reset by an admitted facade. */
  if (!driverPrivateStage && !driverInternal && driverFamily == 2) {
    const char *target = action == SQLITE_ALTER_TABLE ? b :
      (action == SQLITE_DROP_TRIGGER || action == SQLITE_CREATE_TRIGGER ? b : a);
    int original = target && (!sqlite3_stricmp(target, "profile_retired") ||
                              !sqlite3_stricmp(target, "profile_original"));
    if (original &&
        (action == SQLITE_UPDATE || action == SQLITE_DELETE ||
         action == SQLITE_DROP_TABLE || action == SQLITE_ALTER_TABLE ||
         action == SQLITE_CREATE_TRIGGER || action == SQLITE_DROP_TRIGGER))
      return SQLITE_DENY;
    /* INSERT OR REPLACE can delete without a DELETE authorizer event. Only the
     * first original/retirement row is insertable, never a later replacement. */
    if (original && action == SQLITE_INSERT && originalCatalogInsert(driverDb[2], target) != SQLITE_OK)
      return SQLITE_DENY;
  }
  /* The authenticated private source is immutable. Its actual SQL guards
   * were installed by whole-envelope authentication before this kernel claim.
   * Wallet migrations may alter wallet tables, never these source families. */
  if (driverPrivateStage && !driverInternal) {
    const char *protectedTables[] = {"rows", "table_counts", "unique_keys", "memberships",
      "private_binding", "metadata", "private_import", "private_binary_fields", "private_binary_chunks"};
    const char *target = action == SQLITE_ALTER_TABLE ? b :
      (action == SQLITE_DROP_TRIGGER || action == SQLITE_CREATE_TRIGGER ? b : a);
    int protected = 0;
    for (size_t i = 0; target && i < sizeof(protectedTables) / sizeof(protectedTables[0]); i++)
      protected |= !sqlite3_stricmp(target, protectedTables[i]);
    if ((action == SQLITE_DROP_TABLE || action == SQLITE_ALTER_TABLE ||
         action == SQLITE_DROP_TRIGGER || action == SQLITE_CREATE_TRIGGER) && protected)
      return SQLITE_DENY;
    if (action == SQLITE_DROP_TRIGGER && a && !strncmp(a, "brc38_source_seal_", 18))
      return SQLITE_DENY;
  }
  if (action == SQLITE_TRANSACTION || action == SQLITE_SAVEPOINT) {
    driverControl = 1;
    if (a && (!sqlite3_stricmp(a, "BEGIN") || !sqlite3_stricmp(a, "SAVEPOINT")))
      driverBeginControl = 1;
    return driverFamily == 1 && !driverInternal ? SQLITE_DENY : SQLITE_OK;
  }
  if (action == SQLITE_ATTACH || action == SQLITE_DETACH)
    return SQLITE_DENY;
  if (action == SQLITE_FUNCTION && b &&
      (!strcmp(b, "load_extension") || !strcmp(b, "writefile") ||
       !strcmp(b, "readfile")))
    return SQLITE_DENY;
  if (action == SQLITE_PRAGMA && a) {
    if (driverPrivateStage && b && !driverInternal &&
        (!sqlite3_stricmp(a, "secure_delete") || !sqlite3_stricmp(a, "fullfsync")))
      return SQLITE_DENY;
    if (!b && !sqlite3_stricmp(a, "journal_mode"))
      driverReadJournalMode = 1;
    if (b)
      driverControl = 1;
    const char *blocked[] = {"journal_mode",
                             "mmap_size",
                             "temp_store",
                             "temp_store_directory",
                             "data_store_directory",
                             "cache_size",
                             "hard_heap_limit",
                             "soft_heap_limit",
                             "page_size",
                             "max_page_count",
                             "synchronous",
                             "locking_mode",
                             "writable_schema",
                             "busy_timeout"};
    for (size_t i = 0; i < sizeof(blocked) / sizeof(blocked[0]); i++)
      if (!sqlite3_stricmp(a, blocked[i]) && b && !driverInternal)
        return SQLITE_DENY;
  }
  return SQLITE_OK;
}
static void brc38BlobProtocol(sqlite3_context *, int, sqlite3_value **);
static void brc38BlobReadProtocol(sqlite3_context *, int, sqlite3_value **);
static void brc38TextReadProtocol(sqlite3_context *, int, sqlite3_value **);
static void brc38TextExtentBytes(sqlite3_context *, int, sqlite3_value **);
static void brc38LocalFieldProtocol(sqlite3_context *, int, sqlite3_value **);
static void brc38LocalFieldExtentBytes(sqlite3_context *, int, sqlite3_value **);
static void brc38ProfileRetirementProtocol(sqlite3_context *context, int argc,
                                         sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  sqlite3_result_int(context, driverPrivateStage ? 0 : 1);
}
static void brc38SourceRetirementFenceProtocol(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_int(context, !driverPrivateStage && !driverRetiredRead ? 1 : 0);
}
static void brc38SourceRetirementFencePhase(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_int(context, !driverPrivateStage && !driverRetiredRead && driverSourceRetirementFrozen ? 1 : 0);
}
static int profileCatalogNamespace(int *forward, int *retired);
static void brc38RetiredReadProtocol(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_int(context, driverRetiredRead ? 1 : 0);
}
static void brc38RetiredReadPhase(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  int forward = 0, retired = 0, rc = profileCatalogNamespace(&forward, &retired);
  if (rc != SQLITE_OK) sqlite3_result_error_code(context, rc);
  else sqlite3_result_int(context, driverRetiredRead && retired ? 1 : 0);
}
static void brc38PrivateComparisonProtocol(sqlite3_context *context, int argc,
                                         sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_int(context, driverPrivateStage ? 1 : 0);
}
static void brc38PrivateComparisonPhase(sqlite3_context *context, int argc,
                                      sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_int(context, driverPrivateStage && driverCandidateComparison);
}
static void brc38RecoveryStageProtocol(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_int(context, driverRecoveryStage ? 1 : 0);
}
static int privateStageCheck(void);
static int recoveryStageInitializeOwner(void);
static void brc38RecoveryCopyProtocol(sqlite3_context *context, int argc, sqlite3_value **argv);
/* Fresh checks of the original kernel/factory ceilings, not an advertised
 * caller verdict or a cached backend capability. These functions are purposely
 * non-deterministic SQL functions so every execution rechecks the actual child. */
static void brc38RuntimeModel(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  if (brc38NativeRuntimeCheck() != SQLITE_OK) sqlite3_result_error_code(context, SQLITE_AUTH);
  else sqlite3_result_text(context, brc38NativeRuntimeLimitModel, -1, SQLITE_STATIC);
}
static void brc38RuntimeLimit(sqlite3_context *context, int argc, sqlite3_value **argv) {
  if (argc != 1 || sqlite3_value_type(argv[0]) != SQLITE_INTEGER ||
      brc38NativeRuntimeCheck() != SQLITE_OK) { sqlite3_result_error_code(context, SQLITE_AUTH); return; }
  int selected = sqlite3_value_int(argv[0]);
  sqlite3_int64 value;
  switch (selected) {
    case 0: value = brc38RuntimeAddressMaximum; break;
    case 1: value = brc38RuntimeHeapMaximum; break;
    case 2: value = brc38RuntimeDescriptors; break;
#if SQLITE_OS_WIN
    case 3: value = brc38WinPrivateCommitMaximum; break;
    case 4: value = (sqlite3_int64)brc38WinMappedMaximum; break;
#else
    case 3: case 4: value = 0; break;
#endif
    default: sqlite3_result_error_code(context, SQLITE_MISUSE); return;
  }
  sqlite3_result_int64(context, value);
}
static void brc38SharedQuotaEventProtocol(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  if (brc38NativeRuntimeCheck() != SQLITE_OK || driverFamily != 0)
    sqlite3_result_error_code(context, SQLITE_AUTH);
  else sqlite3_result_text(context, "brc38-shared-quota-event/v1", -1, SQLITE_STATIC);
}
/* SQLite cache_size is a page-cache target, not the memory boundary. Reserve
 * at most half the existing hard heap across four driver and two temporary
 * recovery-copy connections; retain headroom for statements/schema/results.
 * A target above 1MiB offers no unmeasured benefit here. Actual allocator,
 * address, file identity, aggregate physical and IPC ceilings stay unchanged. */
static sqlite3_int64 nativeCacheKiB(void) {
  sqlite3_int64 target = brc38RuntimeHeapMaximum /
      (2 * (DRIVER_CONNECTIONS + 2) * 1024);
  return target > 1024 ? 1024 : target;
}
static int openNative(int slot, int readonly) {
  int family = slot == 3 ? 0 : slot;
  char path[PATH_MAX];
  if (slot < 0 || slot >= DRIVER_CONNECTIONS || driverDb[slot] ||
      family >= driverQuota.families)
    return SQLITE_MISUSE;
  if (snprintf(path, sizeof(path), "%s/%s", driverQuota.root,
               driverQuota.names[family * 4]) >= (int)sizeof(path))
    return SQLITE_CANTOPEN;
  sqlite3 *db = NULL;
  int rc = sqlite3_open_v2(
      path, &db, readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE,
      driverQuota.vfs.zName);
  if (rc == SQLITE_OK) {
    char pragmas[256];
    int bytes = snprintf(pragmas, sizeof(pragmas),
        "PRAGMA busy_timeout=0; PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY;"
        "PRAGMA cache_size=-%lld; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        (long long)nativeCacheKiB());
    rc = bytes < 1 || bytes >= (int)sizeof(pragmas) ? SQLITE_MISUSE :
        sqlite3_exec(db, pragmas, NULL, NULL, NULL);
  }
  if (rc == SQLITE_OK && driverPrivateStage) {
    char policy[256];
    int bytes = snprintf(policy, sizeof(policy),
        "PRAGMA journal_mode=DELETE; PRAGMA fullfsync=ON; PRAGMA secure_delete=ON;"
        "PRAGMA max_page_count=%lld;",
        (long long)(driverQuota.mainMaximum[family] / 4096));
    if (bytes < 1 || bytes >= (int)sizeof(policy))
      rc = SQLITE_MISUSE;
    else
      rc = sqlite3_exec(db, policy, NULL, NULL, NULL);
  }
  /* Establish physical read-only/query-only policy before installing the
   * authorizer. Frozen comparison/recovery must never need to mutate a
   * connection setting, and callers still cannot relax the phase fence. */
  if (rc == SQLITE_OK && readonly)
    rc = sqlite3_exec(db, "PRAGMA query_only=ON;", NULL, NULL, NULL);
  if (rc != SQLITE_OK) {
    if (db)
      sqlite3_close(db);
    return rc;
  }
  sqlite3_extended_result_codes(db, 1);
  driverDb[slot] = db;
  /* Length and IPC budgets differ: incremental blob I/O never materializes
   * the complete field. The VFS/allocator/address/packet budgets stay intact. */
  sqlite3_limit(db, SQLITE_LIMIT_LENGTH,
                (int)(driverQuota.maximum < 1000000000 ? driverQuota.maximum
                                                       : 1000000000));
  sqlite3_limit(db, SQLITE_LIMIT_SQL_LENGTH, DRIVER_SQL_MAX);
  rc = brc38RegisterCellComparison(db);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_runtime_model", 0,
                                  SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                  NULL, brc38RuntimeModel, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_shared_quota_event_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38SharedQuotaEventProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_shared_row_charge", -1,
                                    SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
                                    NULL, brc38SharedRowCharge, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_shared_quota_next_bytes", 8,
                                    SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
                                    NULL, brc38SharedQuotaNextBytes, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_runtime_limit", 1,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38RuntimeLimit, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_blob_protocol", 0,
                                  SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
                                  NULL, brc38BlobProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_blob_read_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
                                    NULL, brc38BlobReadProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK && driverPrivateStage)
    rc = sqlite3_create_function_v2(db, "brc38_stage_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
                                    NULL, brc38PrivateStageProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK && driverPrivateStage)
    rc = sqlite3_create_function_v2(db, "brc38_recovery_stage_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
                                    NULL, brc38RecoveryStageProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_text_read_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38TextReadProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_text_extent_bytes", 3,
                                    SQLITE_UTF8 | SQLITE_DIRECTONLY,
                                    NULL, brc38TextExtentBytes, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_local_field_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38LocalFieldProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_local_field_extent_bytes", 3,
                                    SQLITE_UTF8 | SQLITE_DIRECTONLY,
                                    NULL, brc38LocalFieldExtentBytes, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_profile_retirement_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                  NULL, brc38ProfileRetirementProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_source_retirement_fence_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38SourceRetirementFenceProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_source_retirement_fence_phase", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38SourceRetirementFencePhase, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_profile_retired_read_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38RetiredReadProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_profile_retired_read_phase", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38RetiredReadPhase, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_private_comparison_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38PrivateComparisonProtocol, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_private_comparison_phase", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38PrivateComparisonPhase, NULL, NULL, NULL);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function_v2(db, "brc38_recovery_copy_protocol", 0,
                                    SQLITE_UTF8 | SQLITE_INNOCUOUS,
                                    NULL, brc38RecoveryCopyProtocol, NULL, NULL, NULL);
  if (rc != SQLITE_OK) {
    driverDb[slot] = NULL;
    sqlite3_close(db);
    return rc;
  }
  sqlite3_set_authorizer(db, authorization, db);
  return SQLITE_OK;
}
static int controlSql(sqlite3 *db, const char *sqlText) {
  driverInternal = 1;
  int rc = sqlite3_exec(db, sqlText, NULL, NULL, NULL);
  driverInternal = 0;
  return rc;
}
static int closeNative(int slot) {
  if (slot < 0 || slot >= DRIVER_CONNECTIONS || !driverDb[slot])
    return SQLITE_MISUSE;
  sqlite3 *db = driverDb[slot];
  int rc = SQLITE_OK;
  if (!sqlite3_get_autocommit(db))
    rc = controlSql(db, "ROLLBACK;");
  if (rc == SQLITE_OK)
    rc = sqlite3_close(db);
  if (rc == SQLITE_OK)
    driverDb[slot] = NULL;
  return rc;
}
static int bindValues(sqlite3_stmt *s, const unsigned char *p,
                      const unsigned char *end, uint32_t count) {
  if (count != (uint32_t)sqlite3_bind_parameter_count(s))
    return SQLITE_RANGE;
  for (uint32_t i = 0; i < count; i++) {
    if (p == end)
      return SQLITE_MISUSE;
    int tag = *p++;
    int rc = SQLITE_MISUSE;
    if (tag == 0)
      rc = sqlite3_bind_null(s, (int)i + 1);
    else if (tag == 1 || tag == 2) {
      if (end - p < 8)
        return SQLITE_MISUSE;
      uint64_t bits = get64(p);
      p += 8;
      if (tag == 1)
        rc = sqlite3_bind_int64(s, (int)i + 1, (sqlite3_int64)bits);
      else {
        double value;
        memcpy(&value, &bits, 8);
        rc = sqlite3_bind_double(s, (int)i + 1, value);
      }
    } else if (tag == 3 || tag == 4) {
      if (end - p < 4)
        return SQLITE_MISUSE;
      uint32_t n = get32(p);
      p += 4;
      if (n > (size_t)(end - p))
        return SQLITE_MISUSE;
      rc = tag == 3
               ? sqlite3_bind_text(s, (int)i + 1, (const char *)p, (int)n,
                                   SQLITE_STATIC)
               : sqlite3_bind_blob(s, (int)i + 1, p, (int)n, SQLITE_STATIC);
      p += n;
    }
    if (rc != SQLITE_OK)
      return rc;
  }
  return p == end ? SQLITE_OK : SQLITE_MISUSE;
}
static int decodedCharge(uint64_t amount) {
  if (amount > driverDecodedMaximum - driverDecodedCharge)
    return SQLITE_TOOBIG;
  driverDecodedCharge += amount;
  return SQLITE_OK;
}
static int column(sqlite3_stmt *s, int c) {
  int type = sqlite3_column_type(s, c);
  unsigned char tag = (unsigned char)(type == SQLITE_NULL      ? 0
                                      : type == SQLITE_INTEGER ? 1
                                      : type == SQLITE_FLOAT   ? 2
                                      : type == SQLITE_TEXT    ? 3
                                                               : 4);
  int rc = append(&tag, 1);
  if (rc != SQLITE_OK || tag == 0)
    return rc;
  if ((tag == 1 || tag == 2) && decodedCharge(8) != SQLITE_OK)
    return SQLITE_TOOBIG;
  if (tag == 1)
    return append64((uint64_t)sqlite3_column_int64(s, c));
  if (tag == 2) {
    double value = sqlite3_column_double(s, c);
    uint64_t bits;
    memcpy(&bits, &value, 8);
    return append64(bits);
  }
  int n = sqlite3_column_bytes(s, c);
  if (n < 0 || (uint64_t)n + 4 > driverMaximum - driverPosition ||
      decodedCharge((uint64_t)n * (tag == 3 ? 2 : 1)) != SQLITE_OK)
    return SQLITE_TOOBIG;
  /* Charge before asking SQLite to expand a potentially large zeroblob. */
  const void *bytes = tag == 3 ? (const void *)sqlite3_column_text(s, c)
                               : sqlite3_column_blob(s, c);
  if (!bytes && (n || sqlite3_errcode(sqlite3_db_handle(s)) == SQLITE_NOMEM))
    return SQLITE_NOMEM;
  return block(bytes, (size_t)n);
}
/* Fresh catalog DATA only. Full schemas/digests and actual owner membership are
 * verified by the original profile factory. Save the query's authorizer state:
 * this bounded read uses the same actual catalog connection, never a copy. */
static int profileCatalogNamespace(int *forward, int *retired) {
  if (driverPrivateStage || !driverDb[2]) return SQLITE_AUTH;
  int family = driverFamily, internal = driverInternal;
  driverFamily = 2;
  driverInternal = 1;
  sqlite3_stmt *statement = NULL;
  int rc = sqlite3_prepare_v3(driverDb[2],
    "SELECT name,type FROM sqlite_schema WHERE name IN "
    "('profile','profile_original','profile_native','profile_retired') LIMIT 5",
    -1, 0, &statement, NULL);
  int names = 0, count = 0;
  while (rc == SQLITE_OK && (rc = sqlite3_step(statement)) == SQLITE_ROW) {
    const unsigned char *name = sqlite3_column_text(statement, 0),
                        *type = sqlite3_column_text(statement, 1);
    if (!name || !type || strcmp((const char *)type, "table")) { rc = SQLITE_AUTH; break; }
    if (!strcmp((const char *)name, "profile")) names |= 1;
    else if (!strcmp((const char *)name, "profile_original")) names |= 2;
    else if (!strcmp((const char *)name, "profile_native")) names |= 4;
    else if (!strcmp((const char *)name, "profile_retired")) names |= 8;
    count++;
    rc = SQLITE_OK;
  }
  if (rc == SQLITE_DONE)
    rc = (names == 1 && count == 1) || ((names == 6 || names == 10) && count == 2)
      ? SQLITE_OK : SQLITE_AUTH;
  int finalized = sqlite3_finalize(statement);
  driverFamily = family;
  driverInternal = internal;
  *forward = names == 6;
  *retired = names == 10;
  return rc == SQLITE_OK ? finalized : rc;
}
static int profileWalletWritable(void) {
  if (driverPrivateStage) return SQLITE_OK;
  if (driverSourceRetirementFrozen) return SQLITE_AUTH;
  int forward = 0, retired = 0;
  int rc = profileCatalogNamespace(&forward, &retired);
  return rc == SQLITE_OK && retired ? SQLITE_AUTH : rc;
}
/* Promotion follows a committed ACTIVE receipt. This local state check is an
 * additional sequencing guard, never full profile/inventory authentication. */
static int committedProfileState(int activeOnly) {
  sqlite3_stmt *statement = NULL;
  if (driverFenced[0] || driverFenced[2] || !sqlite3_get_autocommit(driverDb[0]) ||
      !sqlite3_get_autocommit(driverDb[2]))
    return SQLITE_AUTH;
  int forward = 0, retired = 0;
  int rc = profileCatalogNamespace(&forward, &retired);
  if (rc != SQLITE_OK || retired) return rc == SQLITE_OK ? SQLITE_AUTH : rc;
  rc = sqlite3_prepare_v3(driverDb[2], forward
      ? "SELECT n.state FROM profile_native AS n JOIN profile_original AS o ON n.slot=o.slot WHERE n.slot=1 LIMIT 2"
      : "SELECT state FROM profile WHERE slot=1 LIMIT 2", -1, 0, &statement, NULL);
  if (rc != SQLITE_OK)
    return rc;
  rc = sqlite3_step(statement);
  int accepted = 0;
  if (rc == SQLITE_ROW && sqlite3_column_type(statement, 0) == SQLITE_TEXT) {
    const unsigned char *state = sqlite3_column_text(statement, 0);
    int bytes = sqlite3_column_bytes(statement, 0);
    accepted = state != NULL &&
      ((bytes == 6 && memcmp(state, "ACTIVE", 6) == 0) ||
       (!activeOnly && ((bytes == 5 && memcmp(state, "READY", 5) == 0) ||
                       (bytes == 10 && memcmp(state, "ACTIVATING", 10) == 0))));
  }
  if (accepted)
    rc = sqlite3_step(statement) == SQLITE_DONE ? SQLITE_OK : SQLITE_AUTH;
  else
    rc = rc == SQLITE_ROW || rc == SQLITE_DONE ? SQLITE_AUTH : rc;
  int finalized = sqlite3_finalize(statement);
  return rc == SQLITE_OK ? finalized : rc;
}
/* Physical sequencing only, never source/target semantics. This irreversible
 * process phase requires a real unmodified BEGIN IMMEDIATE/EXCLUSIVE wallet
 * writer, actual completed forward ACTIVE catalog and current WAL admission.
 * It cannot be reset after catalog failure; close/recovery keeps that failure
 * forward-only. Existing reads and COMMIT/ROLLBACK can still settle. */
static int freezeSourceRetirementFence(void) {
  if (driverPrivateStage || driverRetiredRead || !driverAdmitted || !driverPromoted ||
      !driverDb[0] || !driverDb[2] || driverFenced[0] || driverFenced[2] ||
      sqlite3_get_autocommit(driverDb[0]) || !sqlite3_get_autocommit(driverDb[2]) ||
      sqlite3_txn_state(driverDb[0], "main") != SQLITE_TXN_WRITE || !driverSourceWriterBegin ||
      driverSourceWriterBlobAttempt || sqlite3_total_changes64(driverDb[0]) != driverSourceWriterChanges)
    return SQLITE_AUTH;
  int forward = 0, retired = 0, rc = profileCatalogNamespace(&forward, &retired);
  if (rc != SQLITE_OK || !forward || retired) return rc == SQLITE_OK ? SQLITE_AUTH : rc;
  sqlite3_stmt *statement = NULL;
  rc = sqlite3_prepare_v3(driverDb[2], "SELECT state FROM profile_native WHERE slot=1 LIMIT 2", -1, 0, &statement, NULL);
  if (rc != SQLITE_OK) return rc;
  rc = sqlite3_step(statement);
  if (rc == SQLITE_ROW && sqlite3_column_type(statement, 0) == SQLITE_TEXT &&
      sqlite3_column_bytes(statement, 0) == 6 && memcmp(sqlite3_column_text(statement, 0), "ACTIVE", 6) == 0)
    rc = sqlite3_step(statement) == SQLITE_DONE ? SQLITE_OK : SQLITE_AUTH;
  else rc = rc == SQLITE_ROW || rc == SQLITE_DONE ? SQLITE_AUTH : rc;
  int finalized = sqlite3_finalize(statement);
  if (rc == SQLITE_OK) rc = finalized;
  if (rc == SQLITE_OK) driverSourceRetirementFrozen = 1;
  return rc;
}

static int query(int slot, const unsigned char *p, const unsigned char *end) {
  sqlite3 *db = driverDb[slot];
  int rc = SQLITE_MISUSE, reader = 0, protectedWrite = 0;
  uint16_t cols = 0;
  uint32_t rows = 0;
  sqlite3_stmt *s = NULL;
  int sourceImmediateBegin = 0, originalAutocommit = sqlite3_get_autocommit(db);
  sqlite3_int64 originalChanges = sqlite3_total_changes64(db);
  driverPosition = DRIVER_HEADER;
  driverDecodedCharge = 0;
  driverFamily = slot == 3 ? 0 : slot;
  driverControl = 0;
  driverBeginControl = 0;
  driverReadJournalMode = 0;
  driverMessage[0] = 0;
  driverRollbackCode = driverReleaseCode = 0;
  if (driverFenced[slot]) {
    rc = SQLITE_ABORT;
    goto done;
  }
  if (end - p < 8)
    goto done;
  uint32_t sqlLength = get32(p), count = get32(p + 4);
  p += 8;
  if (!sqlLength || sqlLength > DRIVER_SQL_MAX ||
      sqlLength > (size_t)(end - p) || memchr(p, 0, sqlLength))
    goto done;
  memcpy(driverSql, p, sqlLength);
  driverSql[sqlLength] = 0;
  p += sqlLength;
  const char *tail = NULL;
  rc = sqlite3_prepare_v3(db, (const char *)driverSql, (int)sqlLength + 1, 0,
                          &s, &tail);
  if (rc != SQLITE_OK)
    goto done;
  if (!s) {
    rc = SQLITE_MISUSE;
    goto done;
  }
  /* Permit only whitespace/comments after one prepared statement. */
  if (tail && *tail) {
    sqlite3_stmt *extra = NULL;
    const char *next = NULL;
    rc = sqlite3_prepare_v3(db, tail, -1, 0, &extra, &next);
    if (extra) {
      sqlite3_finalize(extra);
      rc = SQLITE_MISUSE;
    }
    if (rc != SQLITE_OK)
      goto done;
  }
  rc = bindValues(s, p, end, count);
  if (rc != SQLITE_OK)
    goto done;
  reader = sqlite3_column_count(s) > 0;
  int columnCount = sqlite3_column_count(s);
  if (columnCount > UINT16_MAX) {
    rc = SQLITE_TOOBIG;
    goto done;
  }
  cols = (uint16_t)columnCount;
  /* Some no-argument PRAGMAs mutate even without an INSERT/UPDATE authorizer
   * event. Only SQLite-readonly statements and the exact no-argument journal
   * mode observation may enter the retired read transport. */
  if (driverRetiredRead && !sqlite3_stmt_readonly(s) && !driverReadJournalMode) {
    rc = SQLITE_AUTH;
    goto done;
  }
  /* An admitted old provider cannot write after durable retirement, including
   * BEGIN/SAVEPOINT which SQLite reports as readonly. Existing COMMIT/ROLLBACK
   * and reads remain available so the actual final source scope can drain. */
  if (driverFamily == 0 && (driverBeginControl || !sqlite3_stmt_readonly(s)) &&
      !(driverRetiredRead && slot == 3 && sqlite3_db_readonly(db, "main") == 1 && sqlite3_stmt_readonly(s))) {
    rc = profileWalletWritable();
    if (rc != SQLITE_OK) goto done;
  }
  if ((driverFamily == 1 || (!driverAdmitted && driverFamily == 0)) &&
      !sqlite3_stmt_readonly(s) && !driverReadJournalMode) {
    rc = SQLITE_AUTH;
    goto done;
  }
  if (slot == 0 && !driverPrivateStage && !driverRetiredRead && originalAutocommit &&
      driverBeginControl && driverControl && !sqlite3_stmt_readonly(s)) sourceImmediateBegin = 1;
  if (!sqlite3_stmt_readonly(s) && !driverControl && !driverReadJournalMode) {
    rc = controlSql(db, "SAVEPOINT __brc38_reply;");
    if (rc != SQLITE_OK)
      goto done;
    protectedWrite = 1;
  }
  for (int c = 0; c < columnCount; c++) {
    const char *name = sqlite3_column_name(s, c);
    rc = decodedCharge(32 + strlen(name) * 2);
    if (rc != SQLITE_OK)
      goto done;
    rc = block(name, strlen(name));
    if (rc != SQLITE_OK)
      goto done;
  }
  driverDeadline = clockMs() + 10000;
  sqlite3_progress_handler(db, 1000, progress, NULL);
  while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
    if (rows == UINT32_MAX) {
      rc = SQLITE_TOOBIG;
      break;
    }
    rows++;
    rc = decodedCharge(128 + (uint64_t)columnCount * 64);
    if (rc != SQLITE_OK)
      break;
    for (int c = 0; c < columnCount; c++) {
      rc = column(s, c);
      if (rc != SQLITE_OK)
        break;
    }
    if (rc != SQLITE_OK)
      break;
  }
  if (rc == SQLITE_DONE)
    rc = SQLITE_OK;
done:
  sqlite3_progress_handler(db, 0, NULL, NULL);
  if (s) {
    int f = sqlite3_finalize(s);
    if (rc == SQLITE_OK)
      rc = f;
  }
  if (rc != SQLITE_OK)
    snprintf(driverMessage, sizeof(driverMessage), "%s",
             sqlite3_extended_errcode(db) == rc ? sqlite3_errmsg(db)
                                                : sqlite3_errstr(rc));
  if (protectedWrite) {
    if (rc != SQLITE_OK)
      driverRollbackCode = controlSql(db, "ROLLBACK TO __brc38_reply;");
    if (driverRollbackCode == SQLITE_OK)
      driverReleaseCode = controlSql(db, "RELEASE __brc38_reply;");
    if (driverRollbackCode != SQLITE_OK || driverReleaseCode != SQLITE_OK)
      driverFenced[slot] = 1;
    if (rc == SQLITE_OK && driverReleaseCode != SQLITE_OK) {
      rc = driverReleaseCode;
      snprintf(driverMessage, sizeof(driverMessage), "%s", sqlite3_errmsg(db));
    }
  }
  if (slot == 0 && !driverPrivateStage && !driverRetiredRead) {
    if (rc == SQLITE_OK && sourceImmediateBegin && !sqlite3_get_autocommit(db)) {
      driverSourceWriterBegin = 1; driverSourceWriterChanges = originalChanges; driverSourceWriterBlobAttempt = 0;
    }
    if (sqlite3_get_autocommit(db)) { driverSourceWriterBegin = 0; driverSourceWriterBlobAttempt = 0; }
  }
  return emit(db, rc, reader, rc == SQLITE_OK ? rows : 0,
              rc == SQLITE_OK ? cols : 0);
}
/* SQLite incremental BLOB access does not invoke the SQL authorizer. Keep the
 * actual forward-only comparison/retired lifecycle fence at every owned BLOB
 * opening, including future internal call sites. Read handles remain available;
 * no internal SQL-control flag can grant a comparison process a write handle. */
static int brc38OpenNativeBlob(sqlite3 *db, const char *database,
                             const char *table, const char *column,
                             sqlite3_int64 row, int write, sqlite3_blob **blob) {
  if (!blob) return SQLITE_MISUSE;
  *blob = NULL;
  if (write && (driverRetiredRead || driverCandidateComparison)) return SQLITE_AUTH;
  return sqlite3_blob_open(db, database, table, column, row, write, blob);
}
#include "blob_write.c"
#include "blob_read.c"

static int unsignedArg(const char *text, uint64_t *value) {
  if (!text || !*text || *text == '+' || *text == '-' ||
      strspn(text, "0123456789") != strlen(text))
    return 0;
  errno = 0;
  char *end = NULL;
  unsigned long long n = strtoull(text, &end, 10);
  if (errno || *end)
    return 0;
  *value = (uint64_t)n;
  return 1;
}
#include "recovery_copy.c"
static int cleanupDriver(void) {
  int rc = recoveryCopyClose();
  for (int i = 0; i < DRIVER_CONNECTIONS; i++)
    if (driverDb[i]) {
      int c = closeNative(i);
      if (c != SQLITE_OK)
        rc = c;
    }
  if (rc == SQLITE_OK)
    rc = brc38QuotaClose(&driverQuota);
  free(driverInput);
  free(driverOutput);
  return rc;
}
#include "private_stage.c"
#if SQLITE_OS_UNIX
#include "private_stage_contract.c"
#include "native_fixture.c"
#include "range_contract.c"
#include "shared_quota_contract.c"
#include "cell_change_contract.c"
#include "local_observer_contract.c"
#include "local_pointer_projection_contract.c"
#include "local_pointer_group_contract.c"
#include "local_observer_names_contract.c"
#endif
#include "runtime_contract.c"
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--runtime-contract")) return runtimeContracts();
#if SQLITE_OS_UNIX
  if (argc == 2 && !strcmp(argv[1], "--local-observer-names-contract"))
    return localObserverNamesContracts();
  if (argc == 2 && !strcmp(argv[1], "--local-observer-contract"))
    return localObserverContracts();
  if (argc == 2 && !strcmp(argv[1], "--local-pointer-group-contract"))
    return localPointerGroupContracts();
  if (argc == 2 && !strcmp(argv[1], "--local-pointer-projection-contract"))
    return localPointerProjectionContracts();
  if (argc == 2 && !strcmp(argv[1], "--cell-change-contract"))
    return cellChangeContracts();
  if (argc == 2 && !strcmp(argv[1], "--shared-quota-contract"))
    return sharedQuotaContracts();
  if (argc == 2 && !strcmp(argv[1], "--private-stage-contract"))
    return privateStageContracts();
  if (argc == 2 && !strcmp(argv[1], "--range"))
    return rangeContracts();
  if (argc >= 2 &&
      (!strcmp(argv[1], "--test-fixture") || !strcmp(argv[1], "--test-seed")))
    return testFixture(argc, argv);
  if (argc == 1 || (argc == 2 && (!strcmp(argv[1], "--process-loss-writer") ||
                                  !strcmp(argv[1], "--process-loss-recovery"))))
    return brc38LegacyMain(argc, argv);
  if (argc == 2 && !strcmp(argv[1], "--profile")) {
    int result = brc38LegacyMain(1, argv);
    if (result)
      return result;
    if (sqlite3_initialize() != SQLITE_OK)
      return 1;
    sqlite3_hard_heap_limit64(brc38RuntimeHeapMaximum);
    profileRequire(sqlite3_hard_heap_limit64(-1) == brc38RuntimeHeapMaximum,
                   "profile original heap readback");
    profileContracts();
    profileRequire(sqlite3_memory_highwater(0) <= brc38RuntimeHeapMaximum,
                   "profile final allocator peak");
    return sqlite3_shutdown() != SQLITE_OK;
  }
#endif
  driverRecoveryStage = argc == 15 && !strcmp(argv[1], "--recovery-stage");
  driverPrivateStage = driverRecoveryStage || (argc == 14 && !strcmp(argv[1], "--private-stage"));
  driverRetiredRead = argc == 13 && !strcmp(argv[1], "--retired-read");
  if (!driverPrivateStage && !driverRetiredRead && argc != 12)
    return 2;
#if SQLITE_OS_WIN
  if (_setmode(STDIN_FILENO, _O_BINARY) < 0 || _setmode(STDOUT_FILENO, _O_BINARY) < 0) return 3;
#else
  umask(0077);
#endif
  uint64_t a[10] = {0};
  for (int i = 0; i < (driverPrivateStage ? 8 : 10); i++)
    if (!unsignedArg(argv[i + (driverPrivateStage || driverRetiredRead ? 3 : 2)], &a[i]))
      return 2;
  const char *root = argv[driverPrivateStage || driverRetiredRead ? 2 : 1];
  if (driverPrivateStage) {
    uint64_t wall = privateStageWallMs(), mono = clockMs(), remaining;
    if (strlen(argv[11]) != 64 || strspn(argv[11], "0123456789abcdef") != 64 ||
        !unsignedArg(argv[12], &driverStageExpiry) ||
        !unsignedArg(argv[13], &remaining) || remaining < 1 || remaining > UINT64_C(86400000) ||
        driverStageExpiry > UINT64_C(9007199254740991) ||
        wall >= driverStageExpiry || driverStageExpiry - wall > UINT64_C(86400000) ||
        mono == UINT64_MAX || mono > UINT64_MAX - (driverStageExpiry - wall))
      return 2;
    memcpy(driverStageBinding, argv[11], 65);
    if (remaining > driverStageExpiry - wall) remaining = driverStageExpiry - wall;
    driverStageDeadline = mono + remaining;
    if (driverRecoveryStage) {
      if (!unsignedArg(argv[14], &driverOriginalStageExpiry) ||
          driverOriginalStageExpiry < 1 || driverOriginalStageExpiry > wall ||
          driverStageExpiry - wall > UINT64_C(3600000) || remaining > UINT64_C(3600000)) return 2;
      /* Never enter mutable import mode, including the first Root0 request. */
      driverCandidateComparison = 1;
    }
  }
  uint64_t row = a[1];
  if (a[0] < 1048576 || a[0] > UINT64_C(9007199254740991) ||
      row < 1 || row > 16777216)
    return 2;
  sqlite3_int64 heap = (sqlite3_int64)(row * 3 + 1048576);
  /* Keep connection/schema admission separate from the row transfer ceiling.
   * The complete retained-reader fixture needs four simultaneously open slots. */
  if (heap < 8388608)
    heap = 8388608;
  driverMaximum = (size_t)row + 65536;
  driverDecodedMaximum = row * 2 + 65536;
  sqlite3_int64 address =
      ((heap + (sqlite3_int64)driverMaximum * 2 + 16777216 + 33554431) /
       33554432) *
      33554432;
  if (brc38NativeRuntimeInitialize(address, heap, 32) != SQLITE_OK)
    return 3;
  Brc38ProfileEnrollment expected;
  expected.directoryDevice = (Brc38Device)a[2];
  expected.directoryInode = (Brc38Inode)a[3];
  for (int i = 0; i < 3; i++) {
    expected.mainDevice[i] = (Brc38Device)a[4 + i * 2];
    expected.mainInode[i] = (Brc38Inode)a[5 + i * 2];
  }
  int quota = driverPrivateStage
      ? brc38StageQuotaInitialize(&driverQuota, root, (sqlite3_int64)a[0], &expected)
      : brc38ProfileQuotaInitialize(&driverQuota, root, (sqlite3_int64)a[0], &expected);
  if (quota != SQLITE_OK)
    return 3;
  driverInput = malloc(driverMaximum);
  driverOutput = malloc(driverMaximum);
  if (!driverInput || !driverOutput) {
    cleanupDriver();
    return 3;
  }
  if (openNative(1, 0) != SQLITE_OK ||
      controlSql(driverDb[1], "BEGIN IMMEDIATE;") != SQLITE_OK ||
      (driverRecoveryStage && recoveryStageInitializeOwner() != SQLITE_OK) ||
      (driverPrivateStage ? privateStageCheck() : openNative(2, 0)) != SQLITE_OK) {
    cleanupDriver();
    return 3;
  }
  if (driverRetiredRead) {
    int forward = 0, retired = 0;
    if (profileCatalogNamespace(&forward, &retired) != SQLITE_OK || !retired) {
      cleanupDriver(); return 3;
    }
  }
  int result = 0;
  while (1) {
    unsigned char header[4];
    int got = exactRead(STDIN_FILENO, header, 4, 1);
    if (got == 0)
      break;
    if (got < 0) {
      result = 4;
      break;
    }
    uint32_t length = get32(header);
    if (length < 8 || length > driverMaximum ||
        exactRead(STDIN_FILENO, driverInput, length, 0) < 1) {
      result = 4;
      break;
    }
    driverId = get32(driverInput);
    int operation = driverInput[4], slot = driverInput[5];
    driverPosition = DRIVER_HEADER;
    driverBlobReply = 0;
    driverMessage[0] = 0;
    driverRollbackCode = driverReleaseCode = 0;
    if (slot >= DRIVER_CONNECTIONS) {
      result = 4;
      break;
    }
    driverFamily = slot == 3 ? 0 : slot;
    /* The source READ and destination backup stay physically owned together.
     * No queued SQL, new facade or promotion may change either snapshot while
     * a copy is in progress. Teardown always attempts destination drain first. */
    if (recoveryCopyCharged && operation != 11 && operation != 2 && operation != 4) {
      if (emit(driverDb[slot], SQLITE_AUTH, 0, 0, 0)) { result = 4; break; }
      continue;
    }
    if (driverRetiredRead && operation != 2 && operation != 4) {
      int forward = 0, retired = 0, rc = profileCatalogNamespace(&forward, &retired);
      if (rc == SQLITE_OK && (!retired ||
          !(operation == 0 || (operation == 1 && slot == 3) || operation == 7 || operation == 8))) rc = SQLITE_AUTH;
      if (rc != SQLITE_OK) {
        if (emit(driverDb[slot], rc, 0, 0, 0)) { result = 4; break; }
        continue;
      }
    }
    // Teardown is always available after expiry. Every other request freshly
    // checks the actual retained kernel owner and immutable admission deadline.
    if (driverPrivateStage && operation != 2 && operation != 4) {
      int rc = privateStageCheck();
      if (rc != SQLITE_OK) {
        if (emit(driverDb[slot], rc, 0, 0, 0)) { result = 4; break; }
        continue;
      }
    }
    if (operation == 11 && slot == 3) {
      if (recoveryCopyRequest(driverInput + 8, driverInput + length)) { result = 4; break; }
    } else if (operation == 0 && driverDb[slot]) {
      if (query(slot, driverInput + 8, driverInput + length)) {
        result = 4;
        break;
      }
    } else if (operation == 6 && driverDb[slot]) {
      if (brc38WriteBlob(slot, driverInput + 8, driverInput + length)) {
        result = 4;
        break;
      }
    } else if ((operation == 7 || operation == 8) && driverDb[slot]) {
      if (brc38ReadBlob(slot, driverInput + 8, driverInput + length, operation == 8)) {
        result = 4;
        break;
      }
    } else if (operation == 1) {
      int rc = openNative(slot, slot == 3);
      if (emit(driverDb[slot], rc, 0, 0, 0)) {
        result = 4;
        break;
      }
    } else if (operation == 2 && slot != 1 && slot != 2) {
      int rc = recoveryCopyClose();
      if (rc == SQLITE_OK) rc = closeNative(slot);
      if (emit(NULL, rc, 0, 0, 0)) {
        result = 4;
        break;
      }
    } else if (operation == 5 && slot == 0 && driverDb[0] && !driverAdmitted) {
      /* Internal transport phase only. The sealed profile factory must validate
       * its actual claim before admitting DELETE-mode activation writes. */
      int rc = driverPrivateStage ? privateStageAdmit() : committedProfileState(0);
      if (rc == SQLITE_OK)
        driverAdmitted = 1;
      if (emit(NULL, rc, 0, 0, 0)) {
        result = 4;
        break;
      }
    } else if (operation == 9 && length == 8 && driverPrivateStage && slot == 0 && driverDb[0]) {
      int rc = !driverAdmitted || driverFenced[0] || !sqlite3_get_autocommit(driverDb[0]) ||
        (driverDb[3] && !sqlite3_get_autocommit(driverDb[3])) ? SQLITE_AUTH : privateStageAdmit();
      if (rc == SQLITE_OK) driverCandidateComparison = 1;
      if (emit(driverDb[0], rc, 0, 0, 0)) { result = 4; break; }
    } else if (operation == 10 && length == 8 && !driverPrivateStage && !driverRetiredRead && slot == 0 && driverDb[0]) {
      int rc = freezeSourceRetirementFence();
      if (emit(driverDb[0], rc, 0, 0, 0)) { result = 4; break; }
    } else if (operation == 3 && !driverPrivateStage && slot == 0 && driverDb[0] && !driverPromoted) {
      int rc = committedProfileState(1);
      if (rc == SQLITE_OK)
        rc = controlSql(driverDb[0],
                        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      if (rc == SQLITE_OK) {
        driverAdmitted = 1; /* Existing synthetic ACTIVE component path. */
        driverPromoted = 1;
      }
      if (emit(driverDb[0], rc, 0, 0, 0)) {
        result = 4;
        break;
      }
    } else if (operation == 4) {
      if (emit(NULL, SQLITE_OK, 0, 0, 0))
        result = 4;
      break;
    } else if (emit(NULL, SQLITE_MISUSE, 0, 0, 0)) {
      result = 4;
      break;
    }
  }
  int closed = cleanupDriver();
  if (result == 0 && closed != SQLITE_OK)
    result = 5;
  sqlite3_shutdown();
  return result;
}
