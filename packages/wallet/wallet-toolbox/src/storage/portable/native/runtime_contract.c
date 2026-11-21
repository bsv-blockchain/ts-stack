/* Ordinary, one-use isolated process resource contracts. Authored only until
 * the complete source graph is qualified on an independently controlled host. */
static void runtimeRequire(int condition, const char *contract) {
  if (!condition) { fprintf(stderr, "FAIL runtime %s\n", contract); exit(1); }
}
static int runtimeContracts(void) {
#if SQLITE_OS_UNIX
  umask(0077);
#endif
  runtimeRequire(brc38NativeRuntimeInitialize(64 * 1024 * 1024, 4 * 1024 * 1024, 32) == SQLITE_OK,
                 "actual dedicated child original ceilings");
  runtimeRequire(brc38NativeRuntimeCheck() == SQLITE_OK, "fresh original kernel ceiling readback");
  runtimeRequire(brc38NativeRuntimeInitialize(64 * 1024 * 1024, 4 * 1024 * 1024, 32) == SQLITE_MISUSE,
                 "one-use process cannot renew admission");
  void *excess = sqlite3_malloc64(4 * 1024 * 1024 + 1);
  runtimeRequire(excess == NULL, "actual SQLite heap allocation over original ceiling refused");
#if SQLITE_OS_WIN
  runtimeRequire(!strcmp(brc38NativeRuntimeLimitModel, "windows-private-commit-and-owned-handles-v1"),
                 "Windows does not advertise Unix address-space semantics");
  runtimeRequire(brc38WinMappedMaximum == 2 * 1024 * 1024 &&
      brc38WinPrivateCommitMaximum + (sqlite3_int64)brc38WinMappedMaximum == 64 * 1024 * 1024,
      "shared views retain allowance inside the same original byte budget");
  HANDLE tokens[256]; int count = 0;
  while (count < 256 && brc38WinCanOpen()) {
    runtimeRequire(brc38WinOpenToken(&tokens[count]), "actual bounded token handle factory");
    count++;
  }
  runtimeRequire(count > 0 && brc38WinOwnedCount == 32, "actual owned handles reach fixed original ceiling");
  HANDLE denied = NULL;
  runtimeRequire(!brc38WinOpenToken(&denied) && denied == NULL &&
      GetLastError() == ERROR_TOO_MANY_OPEN_FILES, "owned factory denies another actual handle");
  runtimeRequire(brc38NativeRuntimeCheck() == SQLITE_OK, "full owned allowance keeps actual kernel job limits");
  for (int i = count - 1; i >= 0; i--)
    runtimeRequire(brc38WinReleaseHandle(tokens[i]) == SQLITE_OK, "actual original token handle drained");
  runtimeRequire(brc38WinOwnedCount == 1 && brc38WinOwnsHandle(brc38WinJob),
                 "only original self-owned containment job remains");
  void *committed = VirtualAlloc(NULL, 64 * 1024 * 1024, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
  runtimeRequire(committed == NULL, "actual Windows private commitment overflow refused");
  runtimeRequire(brc38WinMappedBytes == 0 && brc38WinViewCount == 0 && brc38WinMapCount == 0,
                 "no outstanding physical shared mapping");
#else
  runtimeRequire(!strcmp(brc38NativeRuntimeLimitModel, "unix-address-space-and-descriptors-v1"),
                 "Unix retains original hard address/descriptor semantics");
  int files[256], count = 0;
  while (count < 256) {
    int fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (fd < 0) { runtimeRequire(errno == EMFILE, "actual kernel descriptor ceiling refused"); break; }
    files[count++] = fd;
  }
  runtimeRequire(count > 0 && count < 32, "existing inherited descriptors count against kernel ceiling");
  for (int i = count - 1; i >= 0; i--)
    runtimeRequire(close(files[i]) == 0, "actual original descriptor drained");
  void *mapped = mmap(NULL, 64 * 1024 * 1024 + 4096, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
  runtimeRequire(mapped == MAP_FAILED && errno == ENOMEM, "actual total address-space overflow refused");
#endif
  runtimeRequire(brc38NativeRuntimeCheck() == SQLITE_OK, "original limits persist after physical cleanup");
  runtimeRequire(sqlite3_memory_highwater(0) <= 4 * 1024 * 1024, "actual SQLite allocator peak within ceiling");
  runtimeRequire(sqlite3_shutdown() == SQLITE_OK, "actual isolated SQLite shutdown");
  puts("PASS native runtime resource contracts");
  return 0;
}
