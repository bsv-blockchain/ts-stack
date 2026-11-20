/* Additive data-comparison contract. The oracle remains the original SQL
 * expression, independently authored here; no admission or quota verdict. */
static int cellContractScalar(sqlite3 *db, const char *sql) {
  sqlite3_stmt *statement = NULL;
  profileRequire(sqlite3_prepare_v2(db, sql, -1, &statement, NULL) == SQLITE_OK,
                 "cell comparison independent SQL prepared");
  profileRequire(sqlite3_step(statement) == SQLITE_ROW &&
                 sqlite3_column_type(statement, 0) == SQLITE_INTEGER,
                 "cell comparison exact integer observation");
  int value = sqlite3_column_int(statement, 0);
  profileRequire(sqlite3_step(statement) == SQLITE_DONE &&
                 sqlite3_finalize(statement) == SQLITE_OK,
                 "cell comparison statement physically drained");
  return value;
}
static int cellChangeContracts(void) {
  profileRequire(brc38NativeRuntimeInitialize(67108864, 4194304, 32) == SQLITE_OK,
                 "cell comparison original runtime ceilings");
  sqlite3 *db = NULL;
  profileRequire(sqlite3_open(":memory:", &db) == SQLITE_OK &&
                 brc38RegisterCellComparison(db) == SQLITE_OK,
                 "cell comparison actual SQLite functions registered");
  profileRequire(cellContractScalar(db,
    "SELECT brc38_cell_change_protocol()='brc38-cell-change/v1'") == 1 &&
    cellContractScalar(db,
    "SELECT count(*) FROM pragma_function_list WHERE builtin=0 AND type='s' AND enc='utf8' AND flags=2099200 AND ((name='brc38_cells_changed' AND narg=-1) OR (name='brc38_cell_change_protocol' AND narg=0))") == 2,
    "cell comparison actual function inventory and protocol");
  const char *values[] = {
    "NULL", "''", "X''", "0", "1", "-1", "0.0", "-0.0", "1.0",
    "1.5", "9223372036854775807", "-9223372036854775808",
    "'0'", "'1'", "'1.0'", "X'31'", "X'3100'", "char(0)",
    "char(233,128512)", "X'C3A9F09F9880'", "'a '", "'A'", "1e300", "1e-300"
  };
  unsigned checks = 0;
  for (size_t i = 0; i < sizeof(values)/sizeof(values[0]); i++)
    for (size_t j = 0; j < sizeof(values)/sizeof(values[0]); j++) {
      char sql[2048];
      int bytes = snprintf(sql, sizeof(sql),
        "SELECT brc38_cells_changed(%s,%s)=(CAST(%s AS BLOB) IS NOT CAST(%s AS BLOB))",
        values[i], values[j], values[i], values[j]);
      profileRequire(bytes > 0 && bytes < (int)sizeof(sql) &&
                     cellContractScalar(db, sql) == 1,
                     "cell comparison full independent typed cross product");
      bytes = snprintf(sql, sizeof(sql),
        "SELECT brc38_cells_changed(NULL,NULL,1,'1',%s,%s,X'',X'')=((CAST(NULL AS BLOB) IS NOT CAST(NULL AS BLOB)) OR (CAST(1 AS BLOB) IS NOT CAST('1' AS BLOB)) OR (CAST(%s AS BLOB) IS NOT CAST(%s AS BLOB)) OR (CAST(X'' AS BLOB) IS NOT CAST(X'' AS BLOB)))",
        values[i], values[j], values[i], values[j]);
      profileRequire(bytes > 0 && bytes < (int)sizeof(sql) &&
                     cellContractScalar(db, sql) == 1,
                     "cell comparison ordered multi-column independent oracle");
      checks += 2;
    }
  /* The first changed pair has the same short circuit as the original OR.
   * A huge lazy zeroblob must never be expanded after that decision. */
  profileRequire(cellContractScalar(db,
    "SELECT brc38_cells_changed(0,1,zeroblob(100000000),0)") == 1,
    "cell comparison original ordered short circuit");
  const char *invalid[] = {"SELECT brc38_cells_changed()",
                           "SELECT brc38_cells_changed(NULL)",
                           "SELECT brc38_cells_changed(NULL,NULL,NULL)"};
  for (size_t i = 0; i < sizeof(invalid)/sizeof(invalid[0]); i++) {
    sqlite3_stmt *statement = NULL;
    profileRequire(sqlite3_prepare_v2(db, invalid[i], -1, &statement, NULL) == SQLITE_OK &&
                   sqlite3_step(statement) == SQLITE_MISUSE,
                   "cell comparison malformed pair arity refuses");
    profileRequire(sqlite3_finalize(statement) == SQLITE_MISUSE,
                   "cell comparison malformed statement drained");
  }
  int maximum = sqlite3_limit(db, SQLITE_LIMIT_FUNCTION_ARG, -1);
  profileRequire(maximum == 1000, "cell comparison original function argument limit");
  char sql[4096];
  size_t used = (size_t)snprintf(sql, sizeof(sql), "SELECT brc38_cells_changed(");
  for (int i = 0; i < maximum; i++) {
    profileRequire(used + 3 < sizeof(sql), "cell comparison bounded argument fixture");
    sql[used++] = '0'; sql[used++] = i == maximum - 1 ? ')' : ',';
  }
  sql[used] = 0;
  profileRequire(cellContractScalar(db, sql) == 0,
                 "cell comparison exact maximum paired arguments");
  sql[used - 1] = ','; sql[used++] = '0'; sql[used++] = ')'; sql[used] = 0;
  sqlite3_stmt *statement = NULL;
  profileRequire(sqlite3_prepare_v2(db, sql, -1, &statement, NULL) == SQLITE_ERROR &&
                 statement == NULL,
                 "cell comparison one excess argument original SQLite refusal");
  profileRequire(sqlite3_prepare_v2(db,
    "SELECT brc38_cells_changed(?1,0)", -1, &statement, NULL) == SQLITE_OK &&
    sqlite3_bind_zeroblob(statement, 1, 3000000) == SQLITE_OK,
    "cell comparison allocation-pressure statement prepared");
  void *pressure = sqlite3_malloc(2000000);
  profileRequire(pressure != NULL && sqlite3_step(statement) == SQLITE_NOMEM,
                 "cell comparison conversion exhaustion cannot return equality");
  sqlite3_free(pressure);
  profileRequire(sqlite3_finalize(statement) == SQLITE_NOMEM,
                 "cell comparison failed allocation statement drained");
  profileRequire(sqlite3_exec(db,
    "CREATE TABLE cells(id INTEGER PRIMARY KEY, a, b); INSERT INTO cells VALUES(1,'1',X'31');"
    "CREATE TABLE changes(n INTEGER); INSERT INTO changes VALUES(0);"
    "CREATE TRIGGER observe_cells AFTER UPDATE ON cells WHEN brc38_cells_changed(OLD.a,NEW.a,OLD.b,NEW.b) BEGIN UPDATE changes SET n=n+1; END;"
    "UPDATE cells SET a=1; SAVEPOINT fixture; UPDATE cells SET b=X'3100'; ROLLBACK TO fixture; RELEASE fixture;",
    NULL, NULL, NULL) == SQLITE_OK &&
    cellContractScalar(db, "SELECT n FROM changes") == 0 &&
    cellContractScalar(db, "SELECT b=X'31' FROM cells") == 1,
    "cell comparison trigger equality and actual savepoint rollback");
  profileRequire(sqlite3_exec(db, "UPDATE cells SET b=X'3100'", NULL, NULL, NULL) == SQLITE_OK &&
                 cellContractScalar(db, "SELECT n FROM changes") == 1,
                 "cell comparison actual changed-cell trigger");
  profileRequire(sqlite3_close(db) == SQLITE_OK &&
                 sqlite3_memory_highwater(0) <= 4194304 &&
                 brc38NativeRuntimeCheck() == SQLITE_OK && sqlite3_shutdown() == SQLITE_OK,
                 "cell comparison original resources and physical SQLite drain");
  printf("PASS independent cell comparison checks=%u argumentLimit=%d fixturesDrained=true\n",
         checks, maximum);
  return 0;
}
