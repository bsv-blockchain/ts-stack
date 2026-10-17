/* Windows operations for the SAME quota VFS and fixed SQLite amalgamation.
 * Actual NTFS handles, file IDs, DACLs, native WAL locks and bounded directory
 * enumeration replace the Unix-specific descriptor operations. No runtime pin
 * or host qualification follows from compiling this file. */
#if !SQLITE_OS_WIN || SQLITE_OS_WINCE || SQLITE_OS_WINRT || !defined(SQLITE_WIN32_HAS_WIDE)
#error The private Windows VFS requires desktop NT wide-character APIs
#endif
#include <stddef.h>

static Brc38Quota *brc38WinOwners[2];
static int brc38WinCreateHookInstalled;
static int brc38WinSlot(Brc38Quota *q, const char *path, int includeShm) {
  if (!path || strlen(path) <= strlen(q->root)) return -1;
  size_t root = strlen(q->root);
  for (size_t i = 0; i < root; i++) {
    char a = path[i], b = q->root[i];
    if (a == '\\') a = '/';
    if (b == '\\') b = '/';
    if (a != b) return -1;
  }
  if (path[root] != '/' && path[root] != '\\') return -1;
  for (int i = 0; i < q->families * 4; i++)
    if ((i % 4 != 3 || includeShm) &&
        (i % 4 < 2 || q->shmBudgets[i / 4] > 0) &&
        !strcmp(path + root + 1, q->names[i])) return i;
  return -1;
}

static int brc38WinWide(const char *name, wchar_t *out, int capacity) {
  return name && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, out, capacity) > 0;
}
static int brc38WinFixedPath(Brc38Quota *q, int slot, wchar_t *out) {
  char path[PATH_MAX];
  if (slot < 0 || slot >= q->families * 4 ||
      snprintf(path, sizeof(path), "%s/%s", q->root, q->names[slot]) >= (int)sizeof(path))
    return SQLITE_IOERR;
  return brc38WinWide(path, out, PATH_MAX) ? SQLITE_OK : SQLITE_IOERR;
}
static int brc38WinStat(HANDLE handle, int directory, Brc38PhysicalStat *s) {
  Brc38WinFileIdentity actual;
  int rc = brc38WinPrivateFileIdentity(handle, directory, &actual);
  if (rc != SQLITE_OK || actual.bytes > INT64_MAX) return SQLITE_IOERR;
  s->st_dev = actual.device; s->st_ino = actual.inode; s->st_size = (sqlite3_int64)actual.bytes;
  return SQLITE_OK;
}
static int brc38NativeStat(Brc38NativeHandle handle, Brc38PhysicalStat *s) {
  return brc38WinStat(handle, 0, s);
}
static Brc38NativeHandle brc38MainHandle(Brc38QuotaFile *f) {
  return ((winFile *)f->real)->h;
}
static int brc38PathStat(Brc38Quota *q, int slot, Brc38PhysicalStat *s) {
  wchar_t path[PATH_MAX];
  if (brc38WinFixedPath(q, slot, path) != SQLITE_OK) return SQLITE_IOERR;
  HANDLE file = brc38WinOpenFile(path, FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE)
    return GetLastError() == ERROR_FILE_NOT_FOUND ? SQLITE_NOTFOUND : SQLITE_IOERR;
  int rc = brc38NativeStat(file, s);
  if (brc38WinReleaseHandle(file) != SQLITE_OK) rc = SQLITE_IOERR;
  return rc;
}
static int brc38AnchorOpen(Brc38Quota *q) {
  wchar_t root[PATH_MAX];
  /* Only absolute local drive paths. NT device, UNC, ADS and relative names
   * cannot borrow the local-profile boundary. */
  size_t length = strlen(q->root);
  if (length < 4 || !((q->root[0] >= 'A' && q->root[0] <= 'Z') ||
                     (q->root[0] >= 'a' && q->root[0] <= 'z')) ||
      q->root[1] != ':' || (q->root[2] != '/' && q->root[2] != '\\') ||
      strchr(q->root + 2, ':') || !brc38WinWide(q->root, root, PATH_MAX)) return SQLITE_CANTOPEN;
  q->directory = brc38WinOpenFile(root, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (q->directory == INVALID_HANDLE_VALUE) return SQLITE_CANTOPEN;
  Brc38PhysicalStat s;
  if (brc38WinStat(q->directory, 1, &s) != SQLITE_OK) return SQLITE_IOERR;
  q->device = s.st_dev; q->inode = s.st_ino;
  return SQLITE_OK;
}
static int brc38AnchorClose(Brc38Quota *q) {
  /* Resource check failures retain their exact OS objects, so a caller can
   * retry physical drain on this owner before another profile is admitted. */
  if (brc38WinDrainFileCheckResources() != SQLITE_OK) return SQLITE_IOERR_CLOSE;
  if (q->directory != INVALID_HANDLE_VALUE && !brc38WinPhysicalClose(q->directory)) return SQLITE_IOERR_CLOSE;
  q->directory = INVALID_HANDLE_VALUE;
  return SQLITE_OK;
}
static int brc38WinNameEquals(const WCHAR *actual, DWORD bytes, const char *expected) {
  size_t length = strlen(expected);
  if (bytes != length * sizeof(WCHAR)) return 0;
  for (size_t i = 0; i < length; i++) if (actual[i] != (WCHAR)(unsigned char)expected[i]) return 0;
  return 1;
}
static int brc38Directory(Brc38Quota *q) {
  Brc38PhysicalStat anchor, named;
  wchar_t root[PATH_MAX];
  if (brc38WinStat(q->directory, 1, &anchor) != SQLITE_OK ||
      anchor.st_dev != q->device || anchor.st_ino != q->inode ||
      !brc38WinWide(q->root, root, PATH_MAX)) return SQLITE_IOERR;
  HANDLE path = brc38WinOpenFile(root, FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (path == INVALID_HANDLE_VALUE) return SQLITE_IOERR;
  int rc = brc38WinStat(path, 1, &named);
  if (brc38WinReleaseHandle(path) != SQLITE_OK) rc = SQLITE_IOERR;
  if (rc != SQLITE_OK || named.st_dev != q->device || named.st_ino != q->inode) return SQLITE_IOERR;
  /* Enumerate the ORIGINAL directory handle, with a fixed 16-KiB buffer and
   * immediate extra-entry refusal. No recursive or archive-sized allocation. */
  union { FILE_ID_BOTH_DIR_INFO aligned; unsigned char bytes[16384]; } entries;
  int count = 0, restart = 1;
  for (;;) {
    if (!GetFileInformationByHandleEx(q->directory,
          restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
          &entries, sizeof(entries))) {
      return GetLastError() == ERROR_NO_MORE_FILES ? SQLITE_OK : SQLITE_IOERR;
    }
    restart = 0;
    size_t offset = 0;
    for (;;) {
      size_t header = offsetof(FILE_ID_BOTH_DIR_INFO, FileName);
      if (offset > sizeof(entries) - header) return SQLITE_IOERR;
      FILE_ID_BOTH_DIR_INFO *e = (FILE_ID_BOTH_DIR_INFO *)(entries.bytes + offset);
      if ((e->FileNameLength % sizeof(WCHAR)) || e->FileNameLength > sizeof(entries) - offset - header)
        return SQLITE_IOERR;
      if (!brc38WinNameEquals(e->FileName, e->FileNameLength, ".") &&
          !brc38WinNameEquals(e->FileName, e->FileNameLength, "..")) {
        int known = 0;
        for (int i = 0; i < q->families * 4; i++)
          if ((i % 4 < 2 || q->shmBudgets[i / 4] > 0) &&
              brc38WinNameEquals(e->FileName, e->FileNameLength, q->names[i])) known = 1;
        if (!known || ++count > q->families * 4 ||
            (e->FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) return SQLITE_IOERR;
      }
      if (!e->NextEntryOffset) break;
      if (e->NextEntryOffset < header + e->FileNameLength ||
          e->NextEntryOffset > sizeof(entries) - offset || (e->NextEntryOffset % 8)) return SQLITE_IOERR;
      offset += e->NextEntryOffset;
    }
  }
}
static int brc38Identity(Brc38Quota *q, int slot, HANDLE handle, int establish) {
  Brc38PhysicalStat native, path;
  Brc38QuotaSlot *s = &q->slots[slot];
  if (brc38Directory(q) != SQLITE_OK || brc38NativeStat(handle, &native) != SQLITE_OK ||
      brc38PathStat(q, slot, &path) != SQLITE_OK ||
      native.st_dev != path.st_dev || native.st_ino != path.st_ino ||
      (s->identity && (native.st_dev != s->device || native.st_ino != s->inode))) {
    q->refusedIdentity++; return SQLITE_IOERR;
  }
  if (!s->identity) {
    if (!establish) { q->refusedIdentity++; return SQLITE_IOERR; }
    s->identity = 1; s->device = native.st_dev; s->inode = native.st_ino;
  }
  if (slot % 4 != 3 && native.st_size > s->charged) s->charged = native.st_size;
  if (slot % 4 == 3 && native.st_size > q->shmBudgets[slot / 4]) return SQLITE_FULL;
  return SQLITE_OK;
}
static int brc38WinShmIdentity(Brc38QuotaFile *f, int establish) {
  winFile *native = (winFile *)f->real;
  if (!native->pShm) return SQLITE_OK;
  winShmNode *node = native->pShm->pShmNode;
  int slot = f->slot / 4 * 4 + 3;
  int rc = brc38Identity(f->quota, slot, node->hSharedShm, establish);
  /* Local NTFS uses a distinct lock handle as well as the mapping handle. */
  if (rc == SQLITE_OK && !node->bUseSharedLockHandle)
    rc = brc38Identity(f->quota, slot, native->pShm->hShm, establish);
  return rc;
}
static int brc38Guard(Brc38QuotaFile *f) {
  int rc = brc38Identity(f->quota, f->slot, brc38MainHandle(f), 0);
  return rc == SQLITE_OK ? brc38WinShmIdentity(f, 0) : rc;
}
static int brc38RegionPerMap(void) { return 1; }
static int brc38ShmEstablish(Brc38QuotaFile *f) {
  winFile *native = (winFile *)f->real;
  int rc = native->pShm ? SQLITE_OK : winOpenSharedMemory(native);
  return rc == SQLITE_OK ? brc38WinShmIdentity(f, 1) : rc;
}
static int brc38ShmPostmap(Brc38QuotaFile *f) { return brc38WinShmIdentity(f, 1); }

/* The only creation hook is installed on the private dedicated SQLite process.
 * It refuses paths outside its two actual VFS owners, supplies a protected DACL
 * before creation, and validates the resulting real handle BEFORE SQLite can
 * write headers or WAL lock bytes. It is never installed in the wallet's host. */
static HANDLE WINAPI brc38WinCreateFile(LPCWSTR filename, DWORD access, DWORD share,
    LPSECURITY_ATTRIBUTES attributes, DWORD disposition, DWORD flags, HANDLE templateFile) {
  char path[PATH_MAX];
  if (attributes || templateFile || (flags & FILE_FLAG_DELETE_ON_CLOSE) ||
      (disposition != OPEN_EXISTING && disposition != OPEN_ALWAYS && disposition != CREATE_NEW) ||
      !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, filename, -1, path, sizeof(path), NULL, NULL)) {
    SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE;
  }
  Brc38Quota *q = NULL; int slot = -1;
  for (int i = 0; i < 2; i++) {
    Brc38Quota *candidate = brc38WinOwners[i];
    if (!candidate) continue;
    int actualSlot = brc38WinSlot(candidate, path, 1);
    if (actualSlot >= 0) { q = candidate; slot = actualSlot; break; }
  }
  if (!q || brc38Directory(q) != SQLITE_OK) {
    SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE;
  }
  HANDLE file = brc38WinCreatePrivateFile(filename, access, share, disposition, flags);
  if (file == INVALID_HANDLE_VALUE) return file;
  if (brc38Identity(q, slot, file, 1) != SQLITE_OK) {
    (void)brc38WinReleaseHandle(file);
    SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE;
  }
  return file;
}
/* Delete the verified original HANDLE. A pathname check followed by DeleteFile
 * could remove a replacement; FileDispositionInfo targets the checked object. */
static int brc38WinDeleteHandle(Brc38Quota *q, int slot) {
  wchar_t path[PATH_MAX];
  if (brc38Directory(q) != SQLITE_OK || brc38WinFixedPath(q, slot, path) != SQLITE_OK)
    return SQLITE_IOERR_DELETE;
  HANDLE file = brc38WinOpenFile(path, DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE)
    return GetLastError() == ERROR_FILE_NOT_FOUND ? SQLITE_OK : SQLITE_IOERR_DELETE;
  int rc = brc38Identity(q, slot, file, 0);
  FILE_DISPOSITION_INFO disposition = {TRUE};
  if (rc == SQLITE_OK && !SetFileInformationByHandle(file, FileDispositionInfo,
      &disposition, sizeof(disposition))) rc = SQLITE_IOERR_DELETE;
  if (brc38WinReleaseHandle(file) != SQLITE_OK) rc = SQLITE_IOERR_DELETE;
  return rc;
}
static int brc38PlatformDelete(Brc38Quota *q, int slot, const char *path, int syncDirectory) {
  (void)path; (void)syncDirectory; /* Pinned win32 VFS has no directory fsync. */
  return brc38WinDeleteHandle(q, slot);
}
static BOOL WINAPI brc38WinDeleteFile(LPCWSTR filename) {
  char path[PATH_MAX];
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, filename, -1,
      path, sizeof(path), NULL, NULL)) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
  for (int i = 0; i < 2; i++) {
    if (!brc38WinOwners[i]) continue;
    int slot = brc38WinSlot(brc38WinOwners[i], path, 1);
    if (slot >= 0) {
      if (brc38WinDeleteHandle(brc38WinOwners[i], slot) == SQLITE_OK) return TRUE;
      SetLastError(ERROR_ACCESS_DENIED); return FALSE;
    }
  }
  SetLastError(ERROR_ACCESS_DENIED); return FALSE;
}
/* Owned mappings have their own original byte ceiling. The job's private
 * commit limit does not account for shared-file views, so these remain charged
 * independently through physical unmap/handle close. */
typedef struct Brc38WinMap {
  HANDLE handle, file;
  uint64_t bytes;
} Brc38WinMap;
static Brc38WinMap brc38WinMaps[256];
static int brc38WinMapCount;
static uint64_t brc38WinMappedBytes, brc38WinMappedMaximum;
static struct { void *address; SIZE_T bytes; } brc38WinViews[256];
static int brc38WinViewCount;
static int brc38WinSharedIdentity(HANDLE file) {
  if (!brc38WinOwnsHandle(file)) return SQLITE_IOERR;
  for (int i = 0; i < 2; i++) {
    Brc38Quota *q = brc38WinOwners[i];
    if (!q) continue;
    for (int slot = 3; slot < q->families * 4; slot += 4) {
      if (!q->slots[slot].identity || !q->shmBudgets[slot / 4]) continue;
      Brc38PhysicalStat actual;
      if (brc38NativeStat(file, &actual) != SQLITE_OK) return SQLITE_IOERR;
      if (actual.st_dev == q->slots[slot].device && actual.st_ino == q->slots[slot].inode)
        return brc38Identity(q, slot, file, 0);
    }
  }
  return SQLITE_IOERR;
}
static HANDLE WINAPI brc38WinCreateMapping(HANDLE file, LPSECURITY_ATTRIBUTES attributes,
    DWORD protection, DWORD high, DWORD low, LPCWSTR name) {
  uint64_t bytes = ((uint64_t)high << 32) | low;
  Brc38PhysicalStat actual;
  if (attributes || name || (protection != PAGE_READWRITE && protection != PAGE_READONLY) ||
      !bytes || !brc38WinCanOpen() || brc38WinMapCount >= 256 ||
      brc38WinSharedIdentity(file) != SQLITE_OK || brc38NativeStat(file, &actual) != SQLITE_OK ||
      bytes > (uint64_t)actual.st_size || bytes > brc38WinMappedMaximum) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL;
  }
  HANDLE map = CreateFileMappingW(file, NULL, protection, high, low, NULL);
  if (!map) return NULL;
  brc38WinRecordHandle(map);
  brc38WinMaps[brc38WinMapCount++] = (Brc38WinMap){map, file, bytes};
  return map;
}
static LPVOID WINAPI brc38WinMapView(HANDLE map, DWORD access, DWORD high, DWORD low, SIZE_T bytes) {
  uint64_t offset = ((uint64_t)high << 32) | low;
  Brc38WinMap *owned = NULL;
  for (int i = 0; i < brc38WinMapCount; i++) if (brc38WinMaps[i].handle == map) owned = &brc38WinMaps[i];
  if (!owned || !brc38WinOwnsHandle(map) || brc38WinSharedIdentity(owned->file) != SQLITE_OK ||
      !bytes || (access != (FILE_MAP_READ | FILE_MAP_WRITE) && access != FILE_MAP_READ) ||
      offset > owned->bytes || bytes > owned->bytes - offset || brc38WinViewCount >= 256 ||
      brc38WinMappedBytes > brc38WinMappedMaximum || bytes > brc38WinMappedMaximum - brc38WinMappedBytes) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL;
  }
  LPVOID address = MapViewOfFile(map, access, high, low, bytes);
  if (!address) return NULL;
  brc38WinViews[brc38WinViewCount].address = address;
  brc38WinViews[brc38WinViewCount++].bytes = bytes;
  brc38WinMappedBytes += bytes;
  return address;
}
static BOOL WINAPI brc38WinUnmapView(LPCVOID address) {
  int index = -1;
  for (int i = 0; i < brc38WinViewCount; i++) if (brc38WinViews[i].address == address) { index = i; break; }
  if (index < 0) { SetLastError(ERROR_INVALID_ADDRESS); return FALSE; }
  if (!UnmapViewOfFile(address)) return FALSE;
  brc38WinMappedBytes -= brc38WinViews[index].bytes;
  brc38WinViews[index] = brc38WinViews[--brc38WinViewCount];
  return TRUE;
}
static BOOL WINAPI brc38WinCloseOwned(HANDLE handle) {
  if (!brc38WinPhysicalClose(handle)) return FALSE;
  for (int i = 0; i < brc38WinMapCount; i++) if (brc38WinMaps[i].handle == handle) {
    brc38WinMaps[i] = brc38WinMaps[--brc38WinMapCount]; break;
  }
  return TRUE;
}
static int brc38PlatformEnroll(Brc38Quota *q) {
  int empty = -1;
  for (int i = 0; i < 2; i++) {
    if (brc38WinOwners[i] == q) return SQLITE_MISUSE;
    if (!brc38WinOwners[i]) empty = i;
  }
  if (empty < 0 || brc38WinHandleCount || brc38WinSecurityCount) return SQLITE_BUSY;
  if (!brc38WinCreateHookInstalled) {
    if (q->underlying->xSetSystemCall(q->underlying, "CreateFileW",
          (sqlite3_syscall_ptr)brc38WinCreateFile) != SQLITE_OK) return SQLITE_ERROR;
    if (q->underlying->xSetSystemCall(q->underlying, "DeleteFileW",
          (sqlite3_syscall_ptr)brc38WinDeleteFile) != SQLITE_OK) return SQLITE_ERROR;
    if (q->underlying->xSetSystemCall(q->underlying, "CreateFileMappingW",
          (sqlite3_syscall_ptr)brc38WinCreateMapping) != SQLITE_OK ||
        q->underlying->xSetSystemCall(q->underlying, "MapViewOfFile",
          (sqlite3_syscall_ptr)brc38WinMapView) != SQLITE_OK ||
        q->underlying->xSetSystemCall(q->underlying, "UnmapViewOfFile",
          (sqlite3_syscall_ptr)brc38WinUnmapView) != SQLITE_OK ||
        q->underlying->xSetSystemCall(q->underlying, "CloseHandle",
          (sqlite3_syscall_ptr)brc38WinCloseOwned) != SQLITE_OK) return SQLITE_ERROR;
    brc38WinCreateHookInstalled = 1;
  }
  brc38WinOwners[empty] = q;
  return SQLITE_OK;
}
static void brc38PlatformWithdraw(Brc38Quota *q) {
  for (int i = 0; i < 2; i++) if (brc38WinOwners[i] == q) brc38WinOwners[i] = NULL;
}
