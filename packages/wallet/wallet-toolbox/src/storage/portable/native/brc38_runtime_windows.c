/* Dedicated Windows child: private committed memory has a kernel job ceiling;
 * shared WAL views and actual owned HANDLEs have separate factory ceilings.
 * This is explicitly NOT an RLIMIT_AS / kernel-wide HANDLE-count equivalent. */
#if !SQLITE_OS_WIN || !defined(_WIN32_WINNT) || _WIN32_WINNT < 0x0602
#error The private Windows runtime requires desktop Windows 8 or later
#endif
#include <psapi.h>
static HANDLE brc38WinJob;
static sqlite3_int64 brc38WinPrivateCommitMaximum;
static DWORD brc38WinJobFlags;
static const char *brc38NativeRuntimeLimitModel = "windows-private-commit-and-owned-handles-v1";

static int brc38NativeRuntimeCheck(void) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  PROCESS_MEMORY_COUNTERS_EX memory;
  BOOL member = FALSE;
  if (!brc38RuntimeClaimed || !brc38WinJob || !brc38WinOwnsHandle(brc38WinJob) ||
      !IsProcessInJob(GetCurrentProcess(), brc38WinJob, &member) || !member ||
      !QueryInformationJobObject(brc38WinJob, JobObjectExtendedLimitInformation,
          &limits, sizeof(limits), NULL) ||
      limits.BasicLimitInformation.LimitFlags != brc38WinJobFlags ||
      limits.BasicLimitInformation.ActiveProcessLimit != 1 ||
      limits.ProcessMemoryLimit != (SIZE_T)brc38WinPrivateCommitMaximum ||
      limits.JobMemoryLimit != (SIZE_T)brc38WinPrivateCommitMaximum ||
      !GetProcessMemoryInfo(GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS *)&memory, sizeof(memory)) ||
      memory.PrivateUsage > (SIZE_T)brc38WinPrivateCommitMaximum ||
      brc38WinOwnedMaximum != brc38RuntimeDescriptors || brc38WinOwnedCount > brc38WinOwnedMaximum ||
      brc38WinMappedBytes > brc38WinMappedMaximum ||
      sqlite3_hard_heap_limit64(-1) != brc38RuntimeHeapMaximum) return SQLITE_AUTH;
  return SQLITE_OK;
}
static int brc38NativeRuntimeInitialize(sqlite3_int64 memoryMaximum,
                                      sqlite3_int64 heapMaximum, int handles) {
  const sqlite3_int64 mappedMaximum = 2 * 1024 * 1024;
  if (brc38RuntimeClaimed || brc38WinJob || brc38WinOwnedMaximum ||
      memoryMaximum < 16 * 1024 * 1024 || memoryMaximum > 1024 * 1024 * 1024 ||
      heapMaximum < 1024 * 1024 || heapMaximum >= (memoryMaximum - mappedMaximum) / 2 ||
      handles < 16 || handles > 256) return SQLITE_MISUSE;
  if (sqlite3_config(SQLITE_CONFIG_MEMSTATUS, 1) != SQLITE_OK) return SQLITE_MISUSE;
  brc38WinPrivateCommitMaximum = memoryMaximum - mappedMaximum;
  brc38WinMappedMaximum = (uint64_t)mappedMaximum;
  brc38WinOwnedMaximum = handles;
  PROCESS_MEMORY_COUNTERS_EX memory;
  if (!GetProcessMemoryInfo(GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS *)&memory, sizeof(memory)) ||
      memory.PrivateUsage > (SIZE_T)brc38WinPrivateCommitMaximum) return SQLITE_ERROR;
  if (!brc38WinCanOpen()) return SQLITE_ERROR;
  brc38WinJob = CreateJobObjectW(NULL, NULL);
  if (!brc38WinJob) return SQLITE_ERROR;
  brc38WinRecordHandle(brc38WinJob);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  memset(&limits, 0, sizeof(limits));
  brc38WinJobFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY |
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  limits.BasicLimitInformation.LimitFlags = brc38WinJobFlags;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  limits.ProcessMemoryLimit = (SIZE_T)brc38WinPrivateCommitMaximum;
  limits.JobMemoryLimit = (SIZE_T)brc38WinPrivateCommitMaximum;
  if (!SetInformationJobObject(brc38WinJob, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !AssignProcessToJobObject(brc38WinJob, GetCurrentProcess())) return SQLITE_ERROR;
  /* Readback alone is not enforcement. Commit more than the entire original
   * allowance; the actual kernel must refuse before SQLite or a profile opens.
   * A successful reserve-only allocation would prove nothing on Windows. */
  void *probe = VirtualAlloc(NULL, (SIZE_T)memoryMaximum + 65536,
                            MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
  if (probe) { (void)VirtualFree(probe, 0, MEM_RELEASE); return SQLITE_ERROR; }
  DWORD refused = GetLastError();
  if (refused != ERROR_NOT_ENOUGH_MEMORY && refused != ERROR_COMMITMENT_LIMIT) return SQLITE_ERROR;
  if (sqlite3_initialize() != SQLITE_OK) return SQLITE_ERROR;
  sqlite3_hard_heap_limit64(heapMaximum);
  brc38RuntimeAddressMaximum = memoryMaximum;
  brc38RuntimeHeapMaximum = heapMaximum;
  brc38RuntimeDescriptors = handles;
  brc38RuntimeClaimed = 1;
  return brc38NativeRuntimeCheck();
}
