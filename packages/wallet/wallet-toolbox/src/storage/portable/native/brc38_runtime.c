/* Private isolated Unix native-process component. These irreversible limits
 * belong to a dedicated child, never the caller's existing wallet process.
 * No production provider/admission/IPC/platform qualification is claimed. */
#if SQLITE_OS_UNIX
#include <sys/resource.h>
#include <sys/mman.h>
#if defined(__APPLE__) && defined(__MACH__)
#include <mach/mach.h>
#endif
#endif

static int brc38RuntimeClaimed;
static sqlite3_int64 brc38RuntimeAddressMaximum;
static sqlite3_int64 brc38RuntimeHeapMaximum;
static int brc38RuntimeDescriptors;

#if SQLITE_OS_WIN
#include "brc38_runtime_windows.c"
#else
static const char *brc38NativeRuntimeLimitModel = "unix-address-space-and-descriptors-v1";
static int brc38NativeRuntimeCheck(void) {
  struct rlimit address, files;
  if (!brc38RuntimeClaimed || getrlimit(RLIMIT_AS, &address) || getrlimit(RLIMIT_NOFILE, &files) ||
      address.rlim_cur != (rlim_t)brc38RuntimeAddressMaximum || address.rlim_max != address.rlim_cur ||
      files.rlim_cur != (rlim_t)brc38RuntimeDescriptors || files.rlim_max != files.rlim_cur ||
      sqlite3_hard_heap_limit64(-1) != brc38RuntimeHeapMaximum) return SQLITE_AUTH;
  return SQLITE_OK;
}
static int brc38NativeRuntimeInitialize(sqlite3_int64 addressMaximum,
                                      sqlite3_int64 heapMaximum, int descriptors) {
#if !defined(__linux__) && !(defined(__APPLE__) && defined(__MACH__))
  (void)addressMaximum; (void)heapMaximum; (void)descriptors;
  return SQLITE_NOTFOUND;
#else
  if (brc38RuntimeClaimed || addressMaximum < 16 * 1024 * 1024
      || addressMaximum > 1024 * 1024 * 1024 || heapMaximum < 1024 * 1024
      || heapMaximum >= addressMaximum / 2 || descriptors < 16 || descriptors > 256)
    return SQLITE_MISUSE;
  /* Lowering RLIMIT_AS does not retroactively remove existing mappings. Verify
   * the current owned executable already fits before accepting the limit. */
  long pageSize = sysconf(_SC_PAGESIZE);
  if (pageSize <= 0) return SQLITE_ERROR;
#if defined(__linux__)
  FILE *statm = fopen("/proc/self/statm", "re");
  unsigned long long mappedPages = 0;
  if (!statm) return SQLITE_ERROR;
  int scanned = fscanf(statm, "%llu", &mappedPages);
  int closed = fclose(statm);
  if (scanned != 1 || closed || pageSize <= 0
      || mappedPages > (unsigned long long)addressMaximum / (unsigned long long)pageSize)
    return SQLITE_ERROR;
#else
  mach_task_basic_info_data_t task;
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
                (task_info_t)&task, &count) != KERN_SUCCESS ||
      count != MACH_TASK_BASIC_INFO_COUNT ||
      task.virtual_size > (mach_vm_size_t)addressMaximum)
    return SQLITE_ERROR;
#endif
  /* Reject an already initialized allocator instead of changing another
   * consumer's accounting. Failures after an irreversible kernel limit must
   * terminate this private child; no caller process retry is supported. */
  if (sqlite3_config(SQLITE_CONFIG_MEMSTATUS, 1) != SQLITE_OK) return SQLITE_MISUSE;
  struct rlimit address = {(rlim_t)addressMaximum, (rlim_t)addressMaximum};
  struct rlimit files = {(rlim_t)descriptors, (rlim_t)descriptors};
  if (setrlimit(RLIMIT_AS, &address) || setrlimit(RLIMIT_NOFILE, &files)) return SQLITE_ERROR;
  struct rlimit actualAddress, actualFiles;
  if (getrlimit(RLIMIT_AS, &actualAddress) || getrlimit(RLIMIT_NOFILE, &actualFiles)
      || actualAddress.rlim_cur != address.rlim_cur || actualAddress.rlim_max != address.rlim_max
      || actualFiles.rlim_cur != files.rlim_cur || actualFiles.rlim_max != files.rlim_max)
    return SQLITE_ERROR;
  /* A getrlimit round trip alone does not prove VM enforcement on a host.
   * Probe an inaccessible anonymous extent larger than the entire allowance;
   * no bytes are touched. Unsupported/ineffective kernels fail closed before
   * SQLite or any profile is opened. The ceiling is never enlarged to fit a
   * host's pre-existing shared mappings. */
  errno = 0;
  void *probe = mmap(NULL, (size_t)addressMaximum + (size_t)pageSize,
                     PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (probe != MAP_FAILED) {
    int unmapped = munmap(probe, (size_t)addressMaximum + (size_t)pageSize);
    (void)unmapped; /* Any result still refuses this one-use private child. */
    return SQLITE_ERROR;
  }
  if (errno != ENOMEM) return SQLITE_ERROR;
  if (sqlite3_initialize() != SQLITE_OK) return SQLITE_ERROR;
  sqlite3_hard_heap_limit64(heapMaximum);
  if (sqlite3_hard_heap_limit64(-1) != heapMaximum) return SQLITE_ERROR;
  brc38RuntimeClaimed = 1;
  brc38RuntimeAddressMaximum = addressMaximum;
  brc38RuntimeHeapMaximum = heapMaximum;
  brc38RuntimeDescriptors = descriptors;
  return SQLITE_OK;
#endif
}

#endif
