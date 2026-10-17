/* Test-only ordinary synthetic setup. Never a production receipt admission. */
static int testFixture(int argc, char **argv) {
  if (argc != 3 && argc != 6)
    return 2;
  const char *root = argv[2];
  if (strncmp(root, "/work/driver-", 13) || strchr(root + 6, '/'))
    return 2;
  umask(0077);
  if (argc == 3 && mkdir(root, 0700))
    return 2;
  int result = 0;
  const char *names[] = {"wallet.sqlite", "owner.sqlite", "profile.sqlite"};
  for (int i = 0; i < 3; i++) {
    char p[PATH_MAX];
    sqlite3 *db = NULL;
    if (snprintf(p, sizeof(p), "%s/%s", root, names[i]) >= (int)sizeof(p))
      return 2;
    int rc = sqlite3_open_v2(
        p, &db, SQLITE_OPEN_READWRITE | (argc == 3 ? SQLITE_OPEN_CREATE : 0),
        NULL);
    if (rc == SQLITE_OK && argc == 3) {
      const char *schema =
          i == 0 ? "PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA "
                   "user_version=0;"
          : i == 1 ? "PRAGMA page_size=4096; CREATE TABLE owner(slot INTEGER "
                     "PRIMARY KEY,binding TEXT NOT NULL); INSERT INTO owner "
                     "VALUES(1,'fixture');"
                   : "PRAGMA page_size=4096; CREATE TABLE profile(slot INTEGER "
                     "PRIMARY KEY,state TEXT NOT NULL,fixedJson TEXT NOT "
                     "NULL,fixedSha256 TEXT NOT NULL,copySha256 TEXT,copyBytes "
                     "INTEGER);";
      rc = sqlite3_exec(db, schema, NULL, NULL, NULL);
    } else if (rc == SQLITE_OK && argc == 6 && i != 0) {
      FILE *file = fopen(argv[3], "re");
      char json[8193];
      size_t n = file ? fread(json, 1, sizeof(json), file) : 0;
      int closed = file ? fclose(file) : 1;
      if (!n || n > 8192 || closed || strlen(argv[4]) != 64 ||
          strlen(argv[5]) != 64)
        rc = SQLITE_MISUSE;
      sqlite3_stmt *s = NULL;
      if (rc == SQLITE_OK)
        rc = sqlite3_prepare_v2(
            db,
            i == 1 ? "UPDATE owner SET binding=? WHERE slot=1"
                   : "INSERT INTO profile(slot,state,fixedJson,fixedSha256) "
                     "VALUES(1,'ACTIVE',?,?)",
            -1, &s, NULL);
      if (rc == SQLITE_OK)
        rc = i == 1 ? sqlite3_bind_text(s, 1, argv[5], -1, SQLITE_STATIC)
                    : sqlite3_bind_text(s, 1, json, (int)n, SQLITE_STATIC);
      if (rc == SQLITE_OK && i == 2)
        rc = sqlite3_bind_text(s, 2, argv[4], -1, SQLITE_STATIC);
      if (rc == SQLITE_OK)
        rc = sqlite3_step(s) == SQLITE_DONE ? SQLITE_OK : sqlite3_errcode(db);
      if (s) {
        int c = sqlite3_finalize(s);
        if (rc == SQLITE_OK)
          rc = c;
      }
    }
    if (db) {
      int c = sqlite3_close(db);
      if (rc == SQLITE_OK)
        rc = c;
    }
    if (rc != SQLITE_OK)
      result = 1;
  }
  if (sqlite3_shutdown() != SQLITE_OK)
    result = 1;
  return result;
}
