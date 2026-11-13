/* Ordinary original-range arithmetic and small-file controls only. */
static int rangeContracts(void) {
  if (brc38NativeRuntimeInitialize(33554432, 4194304, 32) != SQLITE_OK)
    return 1;
  const char *root = "/work/driver-range-contract";
  profileRequire(!mkdir(root, 0700), "range private directory");
  Brc38ProfileEnrollment expected;
  struct stat st;
  profileRequire(!lstat(root, &st), "range actual directory identity");
  expected.directoryDevice = st.st_dev;
  expected.directoryInode = st.st_ino;
  for (int i = 0; i < 3; i++) {
    char name[PATH_MAX];
    profileRequire(snprintf(name, sizeof(name), "%s/%s", root, brc38Names[i * 4]) < (int)sizeof(name), "range bounded path");
    int fd = open(name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    profileRequire(fd >= 0 && !fstat(fd, &st), "range actual private main identity");
    expected.mainDevice[i] = st.st_dev;
    expected.mainInode[i] = st.st_ino;
    profileRequire(!close(fd), "range preparatory descriptor drained");
  }
  const sqlite3_int64 maxima[] = {2147483648, 9007199254740991};
  for (int i = 0; i < 2; i++) {
    Brc38Quota quota;
    profileRequire(brc38ProfileQuotaInitialize(&quota, root, maxima[i], &expected) == SQLITE_OK, "original larger profile range accepted");
    sqlite3_int64 pages = (maxima[i] - 131072) / (3 * 4096);
    if (pages > 2147483646) pages = 2147483646;
    profileRequire(quota.maximum == maxima[i] && quota.mainMaximum[0] == pages * 4096, "original aggregate and clamped page formula retained");
    profileRequire(quota.mainMaximum[1] == 16384 && quota.mainMaximum[2] == 32768 && quota.handles == 0, "original metadata and wrapper controls retained");
    sqlite3 *wallet = profileOpen(&quota, 0);
    sql(wallet, "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS ordinary_range(id INTEGER PRIMARY KEY,n INTEGER); INSERT INTO ordinary_range(n) VALUES(41); PRAGMA wal_checkpoint(TRUNCATE);");
    profileRequire(profileBytes(&quota) < 1048576, "range check writes only bounded ordinary small files");
    profileRequire(sqlite3_close(wallet) == SQLITE_OK, "range native wallet close");
    profileRequire(brc38QuotaClose(&quota) == SQLITE_OK, "range physical ownership release");
    printf("{\"stage\":\"native-original-range\",\"maximumPhysicalBytes\":%lld,\"walletMaximumBytes\":%lld,\"shmMaximumBytes\":%lld}\n", (long long)maxima[i], (long long)(pages * 4096), (long long)quota.shmMaximum);
  }
  Brc38Quota refused;
  profileRequire(brc38ProfileQuotaInitialize(&refused, root, 9007199254740992, &expected) == SQLITE_MISUSE, "unsafe original physical integer refused");
  profileRequire(brc38QuotaInitialize(&refused, root, 1073741825, 32768, 303104) == SQLITE_MISUSE, "legacy standalone upper limit retained");
  profileRemove(root);
  profileRequire(sqlite3_memory_highwater(0) <= 4194304, "range original native allocator limit");
  profileRequire(sqlite3_shutdown() == SQLITE_OK, "range actual SQLite shutdown");
  printf("{\"stage\":\"native-original-range-contract\",\"assertions\":%d,\"passed\":true}\n", profileChecks);
  return 0;
}
