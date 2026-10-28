/* Private #544 native extent/descriptor component. Not a production provider.
 * Compile after the exact pinned SQLite amalgamation in the same translation
 * unit: native handle proofs intentionally use that implementation, never an
 * assumed ABI in a separately compiled or dynamically loaded SQLite library.
 * This bounds logical extents and SHM regions. It does not claim a filesystem
 * block quota, process RSS limit, IPC limit, deadline or durable admission API.
 */
#if (!SQLITE_OS_UNIX && !SQLITE_OS_WIN) || defined(SQLITE_OMIT_WAL)
#error This private component requires the pinned ordinary native WAL VFS
#endif
#include <limits.h>
#if SQLITE_OS_UNIX
#include <dirent.h>
typedef dev_t Brc38Device;
typedef ino_t Brc38Inode;
typedef int Brc38DirectoryHandle;
typedef int Brc38NativeHandle;
typedef struct stat Brc38PhysicalStat;
#define BRC38_INVALID_DIRECTORY (-1)
#else
#include "brc38_windows_handles.c"
typedef uint64_t Brc38Device;
typedef uint64_t Brc38Inode;
typedef HANDLE Brc38DirectoryHandle;
typedef HANDLE Brc38NativeHandle;
typedef struct Brc38PhysicalStat {
  uint64_t st_dev, st_ino;
  sqlite3_int64 st_size;
} Brc38PhysicalStat;
#define BRC38_INVALID_DIRECTORY INVALID_HANDLE_VALUE
#ifndef PATH_MAX
#define PATH_MAX 4096
#endif
#endif

#define BRC38_FILE_SLOTS 4
#define BRC38_PROFILE_FAMILIES 3
#define BRC38_PROFILE_SLOTS (BRC38_FILE_SLOTS * BRC38_PROFILE_FAMILIES)
#define BRC38_MAX_HANDLES 8
#define BRC38_SHM_REGION 32768

typedef struct Brc38Quota Brc38Quota;
typedef struct Brc38QuotaFile Brc38QuotaFile;
typedef struct Brc38QuotaSlot Brc38QuotaSlot;
struct Brc38QuotaSlot {
  sqlite3_int64 charged;
  Brc38Device device;
  Brc38Inode inode;
  int identity;
  int refs;
};
struct Brc38Quota {
  sqlite3_vfs vfs;
  sqlite3_vfs *underlying;
  sqlite3_mutex *mutex;
  Brc38DirectoryHandle directory;
  Brc38Device device;
  Brc38Inode inode;
  char root[PATH_MAX];
  sqlite3_int64 maximum;
  sqlite3_int64 shmMaximum;
  sqlite3_int64 databaseMaximum;
  int families;
  const char *const *names;
  sqlite3_int64 mainMaximum[BRC38_PROFILE_FAMILIES];
  sqlite3_int64 shmBudgets[BRC38_PROFILE_FAMILIES];
  Brc38QuotaSlot slots[BRC38_PROFILE_SLOTS];
  int handles;
  int registered;
  unsigned refusedGrowth;
  unsigned refusedIdentity;
};
struct Brc38QuotaFile {
  sqlite3_file base;
  Brc38Quota *quota;
  sqlite3_file *real;
  int slot;
};

static const char *const brc38Names[BRC38_PROFILE_SLOTS] = {
    "wallet.sqlite",          "wallet.sqlite-journal", "wallet.sqlite-wal",
    "wallet.sqlite-shm",      "owner.sqlite",          "owner.sqlite-journal",
    "owner.sqlite-wal",       "owner.sqlite-shm",      "profile.sqlite",
    "profile.sqlite-journal", "profile.sqlite-wal",    "profile.sqlite-shm"};
/* Expected identities are supplied by a caller that has already verified its
 * original durable profile receipt. This component checks actual native bytes
 * and descriptors; it does not authenticate that receipt or grant activation.
 */
typedef struct Brc38ProfileEnrollment {
  Brc38Device directoryDevice;
  Brc38Inode directoryInode;
  Brc38Device mainDevice[BRC38_PROFILE_FAMILIES];
  Brc38Inode mainInode[BRC38_PROFILE_FAMILIES];
} Brc38ProfileEnrollment;

#if SQLITE_OS_UNIX
static int brc38PrivateFile(const struct stat *s) {
  return S_ISREG(s->st_mode) && (s->st_mode & 0777) == 0600 &&
         s->st_uid == geteuid() && s->st_nlink == 1 && s->st_size >= 0;
}

static int brc38Directory(Brc38Quota *q) {
  struct stat anchor, path;
  if (fstat(q->directory, &anchor) || lstat(q->root, &path) ||
      !S_ISDIR(path.st_mode) || (path.st_mode & 0777) != 0700 ||
      path.st_uid != geteuid() || anchor.st_dev != q->device ||
      anchor.st_ino != q->inode || path.st_dev != q->device ||
      path.st_ino != q->inode)
    return SQLITE_IOERR;
  /* A fixed admitted family count, with an immediate extra-entry refusal. No
   * recursive walk or archive-sized native/name allocation. */
  int fd = openat(q->directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0)
    return SQLITE_IOERR;
  DIR *d = fdopendir(fd);
  if (!d) {
    close(fd);
    return SQLITE_IOERR;
  }
  int count = 0, rc = SQLITE_OK;
  struct dirent *e;
  errno = 0;
  while ((e = readdir(d)) != NULL) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, ".."))
      continue;
    int known = 0;
    for (int i = 0; i < q->families * BRC38_FILE_SLOTS; ++i)
      if (!strcmp(e->d_name, q->names[i]) &&
          (i % 4 < 2 || q->shmBudgets[i / 4] > 0))
        known = 1;
    if (!known || ++count > q->families * BRC38_FILE_SLOTS) {
      rc = SQLITE_IOERR;
      break;
    }
  }
  if (errno)
    rc = SQLITE_IOERR;
  if (closedir(d))
    rc = SQLITE_IOERR;
  return rc;
}

static int brc38Identity(Brc38Quota *q, int slot, int fd, int establish) {
  struct stat native, path;
  Brc38QuotaSlot *s = &q->slots[slot];
  int rc = brc38Directory(q);
  if (rc != SQLITE_OK || fstat(fd, &native) ||
      fstatat(q->directory, q->names[slot], &path, AT_SYMLINK_NOFOLLOW) ||
      !brc38PrivateFile(&native) || !brc38PrivateFile(&path) ||
      native.st_dev != path.st_dev || native.st_ino != path.st_ino ||
      (s->identity &&
       (native.st_dev != s->device || native.st_ino != s->inode))) {
    q->refusedIdentity++;
    return SQLITE_IOERR;
  }
  if (!s->identity) {
    if (!establish) {
      q->refusedIdentity++;
      return SQLITE_IOERR;
    }
    s->identity = 1;
    s->device = native.st_dev;
    s->inode = native.st_ino;
  }
  if (native.st_size > s->charged && slot % 4 != 3)
    s->charged = native.st_size;
  if (slot % 4 == 3 && native.st_size > q->shmBudgets[slot / 4])
    return SQLITE_FULL;
  return SQLITE_OK;
}

static int brc38Guard(Brc38QuotaFile *f) {
  unixFile *native = (unixFile *)f->real;
  int rc = brc38Identity(f->quota, f->slot, native->h, 0);
  if (rc == SQLITE_OK && native->pShm && native->pShm->pShmNode->hShm >= 0)
    rc = brc38Identity(f->quota, f->slot / 4 * 4 + 3,
                       native->pShm->pShmNode->hShm, 0);
  return rc;
}

static int brc38PathStat(Brc38Quota *q, int slot, Brc38PhysicalStat *s) {
  if (!fstatat(q->directory, q->names[slot], s, AT_SYMLINK_NOFOLLOW))
    return brc38PrivateFile(s) ? SQLITE_OK : SQLITE_IOERR;
  return errno == ENOENT ? SQLITE_NOTFOUND : SQLITE_IOERR;
}
static Brc38NativeHandle brc38MainHandle(Brc38QuotaFile *f) {
  return ((unixFile *)f->real)->h;
}
static int brc38NativeStat(Brc38NativeHandle handle, Brc38PhysicalStat *s) {
  return !fstat(handle, s) && brc38PrivateFile(s) ? SQLITE_OK : SQLITE_IOERR;
}
static int brc38AnchorOpen(Brc38Quota *q) {
  q->directory = open(q->root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (q->directory < 0) return SQLITE_CANTOPEN;
  struct stat s;
  if (fstat(q->directory, &s)) return SQLITE_IOERR;
  q->device = s.st_dev; q->inode = s.st_ino;
  return SQLITE_OK;
}
static int brc38AnchorClose(Brc38Quota *q) {
  if (q->directory >= 0 && close(q->directory)) {
    /* Some Unix close errors already release the descriptor. In this sealed
     * single-threaded child, immediately check its actual state before any new
     * descriptor can be opened; never retain/retry an already released number. */
    if (fcntl(q->directory, F_GETFD) < 0 && errno == EBADF) q->directory = BRC38_INVALID_DIRECTORY;
    return SQLITE_IOERR_CLOSE;
  }
  q->directory = BRC38_INVALID_DIRECTORY;
  return SQLITE_OK;
}
static int brc38PlatformDelete(Brc38Quota *q, int slot, const char *path, int syncDirectory) {
  (void)slot;
  return q->underlying->xDelete(q->underlying, path, syncDirectory);
}
static int brc38PlatformEnroll(Brc38Quota *q) { (void)q; return SQLITE_OK; }
static void brc38PlatformWithdraw(Brc38Quota *q) { (void)q; }
static int brc38RegionPerMap(void) { return unixShmRegionPerMap(); }
static int brc38ShmEstablish(Brc38QuotaFile *f) {
  unixFile *native = (unixFile *)f->real;
  int rc = native->pShm ? SQLITE_OK : unixOpenSharedMemory(native);
  if (rc != SQLITE_OK) return rc;
  unixShmNode *node = native->pShm->pShmNode;
  return node->hShm < 0 ? SQLITE_IOERR :
      brc38Identity(f->quota, f->slot / 4 * 4 + 3, node->hShm, 1);
}
static int brc38ShmPostmap(Brc38QuotaFile *f) {
  unixFile *native = (unixFile *)f->real;
  if (!native->pShm) return SQLITE_OK;
  unixShmNode *node = native->pShm->pShmNode;
  return node->hShm < 0 ? SQLITE_IOERR :
      brc38Identity(f->quota, f->slot / 4 * 4 + 3, node->hShm, 1);
}
#else
#include "brc38_quota_windows.c"
#endif

/* Configuration failure cannot abandon an actual anchor if native close
 * fails. Keep the concrete OS handle independently of the caller's C stack
 * object, and reject another configuration until physical retry drains it. */
static Brc38DirectoryHandle brc38FailedAnchors[2];
static int brc38FailedAnchorCount;
static int brc38DrainFailedAnchors(void) {
#if SQLITE_OS_WIN
  if (brc38WinDrainFileCheckResources() != SQLITE_OK) return SQLITE_IOERR_CLOSE;
#endif
  int rc = SQLITE_OK;
  for (int i = brc38FailedAnchorCount - 1; i >= 0; i--) {
#if SQLITE_OS_WIN
    int closed = brc38WinPhysicalClose(brc38FailedAnchors[i]);
#else
    int closed = close(brc38FailedAnchors[i]) == 0;
    if (!closed && fcntl(brc38FailedAnchors[i], F_GETFD) < 0 && errno == EBADF) closed = 1;
#endif
    if (closed) brc38FailedAnchors[i] = brc38FailedAnchors[--brc38FailedAnchorCount];
    else rc = SQLITE_IOERR_CLOSE;
  }
  return rc;
}
static int brc38Reserve(Brc38Quota *q, int slot, sqlite3_int64 extent) {
  if (slot < 0 || slot >= q->families * 4 || extent < 0 || extent > q->maximum)
    goto full;
  if (slot % 4 == 0 && extent > q->mainMaximum[slot / 4])
    goto full;
  if (slot % 4 == 3 && extent > q->shmBudgets[slot / 4])
    goto full;
  /* Every admitted main database owns its eventual checkpoint headroom.
   * Metadata rollback journals and wallet WAL share this SAME aggregate cap. */
  sqlite3_int64 total = 0;
  for (int family = 0; family < q->families; ++family) {
    sqlite3_int64 reserved = q->mainMaximum[family] + q->shmBudgets[family];
    if (reserved > q->maximum - total)
      goto full;
    total += reserved;
  }
  for (int i = 0; i < q->families * 4; ++i) {
    if (i % 4 != 1 && i % 4 != 2)
      continue;
    sqlite3_int64 charge = q->slots[i].charged;
    if (i == slot && extent > charge)
      charge = extent;
    if (charge > q->maximum - total)
      goto full;
    total += charge;
  }
  if (slot % 4 != 3 && extent > q->slots[slot].charged)
    q->slots[slot].charged = extent;
  return SQLITE_OK;
full:
  q->refusedGrowth++;
  return SQLITE_FULL;
}

static int brc38Close(sqlite3_file *file) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  Brc38Quota *q = f->quota;
  sqlite3_mutex_enter(q->mutex);
  int rc = f->real->pMethods->xClose(f->real);
  if (rc == SQLITE_OK) {
    q->handles--;
    q->slots[f->slot].refs--;
    Brc38PhysicalStat s;
    if (q->slots[f->slot].refs == 0 &&
        brc38PathStat(q, f->slot, &s) == SQLITE_NOTFOUND)
      memset(&q->slots[f->slot], 0, sizeof(Brc38QuotaSlot));
    for (int family = 0; family < q->families; ++family) {
      int refs = 0;
      for (int i = family * 4; i < family * 4 + 3; ++i)
        refs += q->slots[i].refs;
      int shm = family * 4 + 3;
      if (!refs && brc38PathStat(q, shm, &s) == SQLITE_NOTFOUND)
        memset(&q->slots[shm], 0, sizeof(Brc38QuotaSlot));
    }
    file->pMethods = NULL;
  }
  sqlite3_mutex_leave(q->mutex);
  return rc;
}

static int brc38Read(sqlite3_file *file, void *buffer, int amount,
                     sqlite3_int64 offset) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  if (amount < 0 || offset < 0)
    return SQLITE_IOERR_READ;
  int rc = brc38Guard(f);
  if (rc != SQLITE_OK) {
    memset(buffer, 0, (size_t)amount);
    return rc;
  }
  /* The original native implementation owns short-read zero filling. */
  return f->real->pMethods->xRead(f->real, buffer, amount, offset);
}

static int brc38Write(sqlite3_file *file, const void *buffer, int amount,
                      sqlite3_int64 offset) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  Brc38Quota *q = f->quota;
  sqlite3_mutex_enter(q->mutex);
  int rc = brc38Guard(f);
  if (rc == SQLITE_OK && (amount < 0 || offset < 0 || offset > q->maximum ||
                          amount > q->maximum - offset))
    rc = SQLITE_FULL;
  if (rc == SQLITE_OK)
    rc = brc38Reserve(q, f->slot, offset + amount);
  if (rc == SQLITE_OK)
    rc = f->real->pMethods->xWrite(f->real, buffer, amount, offset);
  /* A failed write can have made partial progress. Its prospective charge
   * remains until a successful native truncate or actual unlink/close. */
  sqlite3_mutex_leave(q->mutex);
  return rc;
}

static int brc38Truncate(sqlite3_file *file, sqlite3_int64 size) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  Brc38Quota *q = f->quota;
  sqlite3_mutex_enter(q->mutex);
  int rc = brc38Guard(f);
  if (rc == SQLITE_OK)
    rc = brc38Reserve(q, f->slot, size);
  if (rc == SQLITE_OK)
    rc = f->real->pMethods->xTruncate(f->real, size);
  if (rc == SQLITE_OK) {
    Brc38PhysicalStat actual;
    if (brc38NativeStat(brc38MainHandle(f), &actual) != SQLITE_OK || actual.st_size != size)
      rc = SQLITE_IOERR;
    else
      q->slots[f->slot].charged = size;
  }
  sqlite3_mutex_leave(q->mutex);
  return rc;
}

static int brc38Sync(sqlite3_file *file, int flags) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  int rc = brc38Guard(f);
  return rc == SQLITE_OK ? f->real->pMethods->xSync(f->real, flags) : rc;
}
static int brc38Size(sqlite3_file *file, sqlite3_int64 *size) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  int rc = brc38Guard(f);
  return rc == SQLITE_OK ? f->real->pMethods->xFileSize(f->real, size) : rc;
}
static int brc38Lock(sqlite3_file *file, int lock) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  int rc = brc38Guard(f);
  return rc == SQLITE_OK ? f->real->pMethods->xLock(f->real, lock) : rc;
}
static int brc38Unlock(sqlite3_file *file, int lock) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  return f->real->pMethods->xUnlock(f->real, lock);
}
static int brc38Reserved(sqlite3_file *file, int *reserved) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  return f->real->pMethods->xCheckReservedLock(f->real, reserved);
}
static int brc38Control(sqlite3_file *file, int operation, void *argument) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  switch (operation) {
  case SQLITE_FCNTL_SIZE_HINT:
    return SQLITE_OK; /* No unchecked fallocate. */
  case SQLITE_FCNTL_CHUNK_SIZE:
    return *(int *)argument == 0 ? SQLITE_OK : SQLITE_NOTFOUND;
  case SQLITE_FCNTL_MMAP_SIZE:
    *(sqlite3_int64 *)argument = 0;
    break;
  case SQLITE_FCNTL_FILE_POINTER:
    *(sqlite3_file **)argument = file;
    return SQLITE_OK;
  case SQLITE_FCNTL_NULL_IO:
    return SQLITE_NOTFOUND;
  case SQLITE_FCNTL_BEGIN_ATOMIC_WRITE:
  case SQLITE_FCNTL_COMMIT_ATOMIC_WRITE:
  case SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE:
    return SQLITE_NOTFOUND;
  }
  return f->real->pMethods->xFileControl(f->real, operation, argument);
}
static int brc38Sector(sqlite3_file *file) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  return f->real->pMethods->xSectorSize(f->real);
}
static int brc38Characteristics(sqlite3_file *file) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  return f->real->pMethods->xDeviceCharacteristics(f->real) &
         ~(SQLITE_IOCAP_ATOMIC | SQLITE_IOCAP_ATOMIC512 |
           SQLITE_IOCAP_ATOMIC1K | SQLITE_IOCAP_ATOMIC2K |
           SQLITE_IOCAP_ATOMIC4K | SQLITE_IOCAP_ATOMIC8K |
           SQLITE_IOCAP_ATOMIC16K | SQLITE_IOCAP_ATOMIC32K |
           SQLITE_IOCAP_ATOMIC64K | SQLITE_IOCAP_BATCH_ATOMIC);
}

static int brc38ShmMap(sqlite3_file *file, int region, int size, int extend,
                       void volatile **mapped) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  Brc38Quota *q = f->quota;
  *mapped = NULL;
  sqlite3_mutex_enter(q->mutex);
  int rc = brc38Guard(f);
  int perMap = brc38RegionPerMap();
  sqlite3_int64 shmMaximum = q->shmBudgets[f->slot / 4];
  if (rc == SQLITE_OK &&
      (region < 0 || size != BRC38_SHM_REGION || perMap < 1 ||
       region >= shmMaximum / size ||
       ((sqlite3_int64)region / perMap + 1) * perMap * size > shmMaximum)) {
    q->refusedGrowth++;
    rc = SQLITE_FULL;
  }
  /* Establish the small native SHM handle before mapping/region growth. The
   * pinned native routine retains all of its ordinary dead-man/locking checks;
   * a whole SHM extent is already reserved, including its initial three-byte
   * initialization. This is not a cross-process filesystem quota boundary. */
  if (rc == SQLITE_OK) rc = brc38ShmEstablish(f);
  if (rc == SQLITE_OK)
    rc = f->real->pMethods->xShmMap(f->real, region, size, extend, mapped);
  if (rc == SQLITE_OK) rc = brc38ShmPostmap(f);
  if (rc != SQLITE_OK) *mapped = NULL;
  sqlite3_mutex_leave(q->mutex);
  return rc;
}
static int brc38ShmLock(sqlite3_file *file, int offset, int count, int flags) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  int rc = brc38Guard(f);
  return rc == SQLITE_OK
             ? f->real->pMethods->xShmLock(f->real, offset, count, flags)
             : rc;
}
static void brc38ShmBarrier(sqlite3_file *file) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  f->real->pMethods->xShmBarrier(f->real);
}
static int brc38ShmUnmap(sqlite3_file *file, int remove) {
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  /* Native descriptors/maps still drain after refusal, but a pathname delete
   * must not reach a replacement directory or shared-memory inode. */
  if (remove && brc38Guard(f) != SQLITE_OK)
    remove = 0;
  return f->real->pMethods->xShmUnmap(f->real, remove);
}
static int brc38Fetch(sqlite3_file *file, sqlite3_int64 offset, int amount,
                      void **mapped) {
  (void)file;
  (void)offset;
  (void)amount;
  *mapped = NULL;
  return SQLITE_OK;
}
static int brc38Unfetch(sqlite3_file *file, sqlite3_int64 offset,
                        void *mapped) {
  (void)file;
  (void)offset;
  (void)mapped;
  return SQLITE_OK;
}
static const sqlite3_io_methods brc38Methods = {3,
                                                brc38Close,
                                                brc38Read,
                                                brc38Write,
                                                brc38Truncate,
                                                brc38Sync,
                                                brc38Size,
                                                brc38Lock,
                                                brc38Unlock,
                                                brc38Reserved,
                                                brc38Control,
                                                brc38Sector,
                                                brc38Characteristics,
                                                brc38ShmMap,
                                                brc38ShmLock,
                                                brc38ShmBarrier,
                                                brc38ShmUnmap,
                                                brc38Fetch,
                                                brc38Unfetch};

static int brc38Slot(Brc38Quota *q, const char *path) {
#if SQLITE_OS_WIN
  return brc38WinSlot(q, path, 0);
#else
  if (!path)
    return -1;
  size_t root = strlen(q->root);
  if (strncmp(q->root, path, root) || path[root] != '/')
    return -1;
  for (int i = 0; i < q->families * 4; ++i)
    if (i % 4 != 3 && !strcmp(path + root + 1, q->names[i]))
      return i;
  return -1;
#endif
}
static int brc38Open(sqlite3_vfs *vfs, const char *path, sqlite3_file *file,
                     int flags, int *out) {
  Brc38Quota *q = vfs->pAppData;
  Brc38QuotaFile *f = (Brc38QuotaFile *)file;
  memset(file, 0, (size_t)vfs->szOsFile);
  f->quota = q;
  f->real = (sqlite3_file *)(f + 1);
  f->slot = brc38Slot(q, path);
  if (f->slot < 0 || (flags & SQLITE_OPEN_DELETEONCLOSE) ||
      (f->slot % 4 == 0 && !(flags & SQLITE_OPEN_MAIN_DB)) ||
      (f->slot % 4 == 1 && !(flags & SQLITE_OPEN_MAIN_JOURNAL)) ||
      (f->slot % 4 == 2 &&
       (!(flags & SQLITE_OPEN_WAL) || q->shmBudgets[f->slot / 4] == 0)))
    return SQLITE_CANTOPEN;
  sqlite3_mutex_enter(q->mutex);
  int rc = brc38Directory(q);
  if (rc == SQLITE_OK && q->handles >= BRC38_MAX_HANDLES)
    rc = SQLITE_CANTOPEN;
  Brc38PhysicalStat before;
  if (rc == SQLITE_OK) {
    int existing = brc38PathStat(q, f->slot, &before);
    if (existing != SQLITE_OK && existing != SQLITE_NOTFOUND) rc = SQLITE_CANTOPEN;
  }
  if (rc == SQLITE_OK)
    rc = q->underlying->xOpen(q->underlying, path, f->real, flags, out);
  if (rc == SQLITE_OK) {
    rc = brc38Identity(q, f->slot, brc38MainHandle(f), 1);
    if (rc == SQLITE_OK)
      rc = brc38Reserve(q, f->slot, q->slots[f->slot].charged);
  }
  if (rc == SQLITE_OK) {
    q->handles++;
    q->slots[f->slot].refs++;
    file->pMethods = &brc38Methods;
  } else if (f->real->pMethods) {
    int close = f->real->pMethods->xClose(f->real);
    if (close != SQLITE_OK)
      rc = close;
    f->real->pMethods = NULL;
  }
  sqlite3_mutex_leave(q->mutex);
  return rc;
}
static int brc38Delete(sqlite3_vfs *vfs, const char *path, int syncDirectory) {
  Brc38Quota *q = vfs->pAppData;
  int slot = brc38Slot(q, path);
  if (slot < 0)
    return SQLITE_IOERR_DELETE;
  sqlite3_mutex_enter(q->mutex);
  int rc = brc38Directory(q);
  Brc38PhysicalStat s;
  if (rc == SQLITE_OK) {
    int existing = brc38PathStat(q, slot, &s);
    if (existing == SQLITE_OK) {
      if (!q->slots[slot].identity || s.st_dev != q->slots[slot].device ||
          s.st_ino != q->slots[slot].inode) rc = SQLITE_IOERR_DELETE;
    } else if (existing != SQLITE_NOTFOUND) rc = SQLITE_IOERR_DELETE;
  }
  if (rc == SQLITE_OK)
    rc = brc38PlatformDelete(q, slot, path, syncDirectory);
  if (rc == SQLITE_OK && q->slots[slot].refs == 0)
    memset(&q->slots[slot], 0, sizeof(Brc38QuotaSlot));
  sqlite3_mutex_leave(q->mutex);
  return rc;
}
static int brc38Access(sqlite3_vfs *vfs, const char *path, int flags,
                       int *result) {
  Brc38Quota *q = vfs->pAppData;
  if (brc38Slot(q, path) < 0) {
    *result = 0;
    return SQLITE_OK;
  }
  return q->underlying->xAccess(q->underlying, path, flags, result);
}
static int brc38FullPath(sqlite3_vfs *vfs, const char *path, int size,
                         char *out) {
  Brc38Quota *q = vfs->pAppData;
  int rc = q->underlying->xFullPathname(q->underlying, path, size, out);
  return rc == SQLITE_OK && brc38Slot(q, out) < 0 ? SQLITE_CANTOPEN : rc;
}

/* Other VFS operations receive the original VFS, including its pAppData. */
static void *brc38DlOpen(sqlite3_vfs *v, const char *p) {
  Brc38Quota *q = v->pAppData;
  return q->underlying->xDlOpen(q->underlying, p);
}
static void brc38DlError(sqlite3_vfs *v, int n, char *p) {
  Brc38Quota *q = v->pAppData;
  q->underlying->xDlError(q->underlying, n, p);
}
static void (*brc38DlSym(sqlite3_vfs *v, void *h, const char *s))(void) {
  Brc38Quota *q = v->pAppData;
  return q->underlying->xDlSym(q->underlying, h, s);
}
static void brc38DlClose(sqlite3_vfs *v, void *h) {
  Brc38Quota *q = v->pAppData;
  q->underlying->xDlClose(q->underlying, h);
}
static int brc38Random(sqlite3_vfs *v, int n, char *p) {
  Brc38Quota *q = v->pAppData;
  return q->underlying->xRandomness(q->underlying, n, p);
}
static int brc38Sleep(sqlite3_vfs *v, int n) {
  Brc38Quota *q = v->pAppData;
  return q->underlying->xSleep(q->underlying, n);
}
static int brc38Time(sqlite3_vfs *v, double *p) {
  Brc38Quota *q = v->pAppData;
  return q->underlying->xCurrentTime(q->underlying, p);
}
static int brc38Error(sqlite3_vfs *v, int n, char *p) {
  Brc38Quota *q = v->pAppData;
  return q->underlying->xGetLastError(q->underlying, n, p);
}
static int brc38Time64(sqlite3_vfs *v, sqlite3_int64 *p) {
  Brc38Quota *q = v->pAppData;
  return q->underlying->xCurrentTimeInt64(q->underlying, p);
}
static int brc38SetCall(sqlite3_vfs *v, const char *n, sqlite3_syscall_ptr p) {
  (void)v;
  (void)n;
  (void)p;
  return SQLITE_NOTFOUND;
}
static sqlite3_syscall_ptr brc38GetCall(sqlite3_vfs *v, const char *n) {
  (void)v;
  (void)n;
  return NULL;
}
static const char *brc38NextCall(sqlite3_vfs *v, const char *n) {
  (void)v;
  (void)n;
  return NULL;
}

static int brc38QuotaConfigureNamed(Brc38Quota *q, const char *root,
                               sqlite3_int64 maximum, sqlite3_int64 shmMaximum,
                               sqlite3_int64 databaseMaximum,
                               const Brc38ProfileEnrollment *expected, int privateStage,
                               const char *name) {
  if (!name || sqlite3_vfs_find(name))
    return SQLITE_MISUSE;
  memset(q, 0, sizeof(*q));
  q->directory = BRC38_INVALID_DIRECTORY;
  if (brc38FailedAnchorCount) return SQLITE_BUSY;
  if (!root || strlen(root) >= sizeof(q->root) || maximum < 65536 ||
      maximum > (expected ? ((sqlite3_int64)9007199254740991) : ((sqlite3_int64)1073741824)) ||
      (privateStage ? shmMaximum != 0 : shmMaximum < BRC38_SHM_REGION) ||
      shmMaximum % BRC38_SHM_REGION || shmMaximum >= maximum ||
      databaseMaximum < 4096 || databaseMaximum % 4096 ||
      databaseMaximum >= maximum - shmMaximum)
    return SQLITE_MISUSE;
  q->maximum = maximum;
  q->shmMaximum = shmMaximum;
  q->databaseMaximum = databaseMaximum;
  static const char *const stageNames[BRC38_PROFILE_SLOTS] = {
      "stage.sqlite", "stage.sqlite-journal", "stage.sqlite-wal", "stage.sqlite-shm",
      "brc38-owner.sqlite", "brc38-owner.sqlite-journal", "brc38-owner.sqlite-wal", "brc38-owner.sqlite-shm",
      NULL, NULL, NULL, NULL};
  if (privateStage && !expected)
    return SQLITE_MISUSE;
  q->families = privateStage ? 2 : (expected ? BRC38_PROFILE_FAMILIES : 1);
  q->names = privateStage ? stageNames : brc38Names;
  q->mainMaximum[0] = databaseMaximum;
  q->shmBudgets[0] = shmMaximum;
  if (expected) {
    /* These metadata caps retain the original published profile's four/eight
     * 4096-byte page allowances. They are not additional reservations. */
    q->mainMaximum[1] = 4 * 4096;
    if (!privateStage) q->mainMaximum[2] = 8 * 4096;
  }
  strcpy(q->root, root);
#if SQLITE_OS_UNIX
  q->underlying = sqlite3_vfs_find("unix");
#else
  q->underlying = sqlite3_vfs_find("win32");
#endif
  if (!q->underlying || q->underlying->iVersion != 3)
    return SQLITE_ERROR;
  if (brc38AnchorOpen(q) != SQLITE_OK) goto fail;
  if (expected && (expected->directoryDevice != q->device ||
                   expected->directoryInode != q->inode))
    goto fail;
  if (brc38Directory(q) != SQLITE_OK)
    goto fail;
  for (int i = 0; i < q->families * BRC38_FILE_SLOTS; ++i) {
    Brc38PhysicalStat s;
    int existing = brc38PathStat(q, i, &s);
    if (existing == SQLITE_OK) {
      if (i % 4 == 3 && s.st_size > q->shmBudgets[i / 4]) goto fail;
      if (expected && i % 4 == 0 &&
          (s.st_dev != expected->mainDevice[i / 4] ||
           s.st_ino != expected->mainInode[i / 4])) goto fail;
      q->slots[i].identity = 1;
      q->slots[i].device = s.st_dev;
      q->slots[i].inode = s.st_ino;
      q->slots[i].charged = s.st_size;
    } else if (existing != SQLITE_NOTFOUND || (expected && i % 4 == 0)) goto fail;
  }
  for (int i = 0; i < q->families * 4; ++i)
    if (brc38Reserve(q, i, q->slots[i].charged) != SQLITE_OK)
      goto fail;
  q->mutex = sqlite3_mutex_alloc(SQLITE_MUTEX_FAST);
  if (!q->mutex)
    goto fail;
  q->vfs = *q->underlying;
  q->vfs.zName = name;
  q->vfs.pAppData = q;
  q->vfs.szOsFile = sizeof(Brc38QuotaFile) + q->underlying->szOsFile;
  q->vfs.xOpen = brc38Open;
  q->vfs.xDelete = brc38Delete;
  q->vfs.xAccess = brc38Access;
  q->vfs.xFullPathname = brc38FullPath;
  q->vfs.xDlOpen = brc38DlOpen;
  q->vfs.xDlError = brc38DlError;
  q->vfs.xDlSym = brc38DlSym;
  q->vfs.xDlClose = brc38DlClose;
  q->vfs.xRandomness = brc38Random;
  q->vfs.xSleep = brc38Sleep;
  q->vfs.xCurrentTime = brc38Time;
  q->vfs.xGetLastError = brc38Error;
  q->vfs.xCurrentTimeInt64 = brc38Time64;
  q->vfs.xSetSystemCall = brc38SetCall;
  q->vfs.xGetSystemCall = brc38GetCall;
  q->vfs.xNextSystemCall = brc38NextCall;
  int rc = brc38PlatformEnroll(q);
  if (rc == SQLITE_OK) rc = sqlite3_vfs_register(&q->vfs, 0);
  if (rc == SQLITE_OK) {
    q->registered = 1;
    return SQLITE_OK;
  }
fail:
  if (q->mutex)
    sqlite3_mutex_free(q->mutex);
  brc38PlatformWithdraw(q);
  if (brc38AnchorClose(q) != SQLITE_OK && q->directory != BRC38_INVALID_DIRECTORY) {
    /* Fresh configuration is blocked above while any original anchor remains,
     * so this fixed slot cannot be consumed by repeated failures. */
    brc38FailedAnchors[brc38FailedAnchorCount++] = q->directory;
    q->directory = BRC38_INVALID_DIRECTORY;
  }
  q->mutex = NULL;
  return SQLITE_CANTOPEN;
}

static int brc38QuotaConfigure(Brc38Quota *q, const char *root,
                               sqlite3_int64 maximum, sqlite3_int64 shmMaximum,
                               sqlite3_int64 databaseMaximum,
                               const Brc38ProfileEnrollment *expected, int privateStage) {
  return brc38QuotaConfigureNamed(q, root, maximum, shmMaximum, databaseMaximum,
                                 expected, privateStage, "brc38-owner-quota");
}

static int brc38QuotaClose(Brc38Quota *q) {
  if (q->handles)
    return SQLITE_BUSY;
  if (brc38DrainFailedAnchors() != SQLITE_OK) return SQLITE_IOERR_CLOSE;
  if (q->registered) {
    int rc = sqlite3_vfs_unregister(&q->vfs);
    if (rc != SQLITE_OK)
      return rc;
    q->registered = 0;
  }
  int closed = brc38AnchorClose(q);
  if (closed != SQLITE_OK) return closed;
  brc38PlatformWithdraw(q);
  if (q->mutex)
    sqlite3_mutex_free(q->mutex);
  q->mutex = NULL;
  return SQLITE_OK;
}

#if SQLITE_OS_UNIX
static int brc38QuotaInitialize(Brc38Quota *q, const char *root,
                                sqlite3_int64 maximum, sqlite3_int64 shmMaximum,
                                sqlite3_int64 databaseMaximum) {
  return brc38QuotaConfigure(q, root, maximum, shmMaximum, databaseMaximum,
                             NULL, 0);
}
#endif
static int brc38ProfileQuotaInitialize(Brc38Quota *q, const char *root,
                                       sqlite3_int64 originalMaximum,
                                       const Brc38ProfileEnrollment *expected) {
  if (!expected || originalMaximum < 1048576 ||
      originalMaximum > ((sqlite3_int64)9007199254740991))
    return SQLITE_MISUSE;
  /* Same integer page formula as the current original profile admission. */
  sqlite3_int64 walletPages = (originalMaximum - 131072) / (3 * 4096);
  if (walletPages > ((sqlite3_int64)2147483646))
    walletPages = ((sqlite3_int64)2147483646);
  sqlite3_int64 walletMaximum = walletPages * 4096;
  /* Bound every possible WAL-index region from the SAME original aggregate.
   * A legal sixteen-MiB record exceeds the first 4062-frame region. The one-MiB
   * contracts still derive exactly one 32768-byte region. SHM/checkpoint growth
   * stays charged before native growth. This is not an aggregate enlargement.
   */
  sqlite3_int64 frames = (originalMaximum - 32) / (4096 + 24);
  sqlite3_int64 firstFrames = (sqlite3_int64)HASHTABLE_NPAGE_ONE;
  sqlite3_int64 regions =
      frames <= firstFrames
          ? 1
          : 1 + (frames - firstFrames + HASHTABLE_NPAGE - 1) / HASHTABLE_NPAGE;
  int perMap = brc38RegionPerMap();
  if (perMap < 1)
    return SQLITE_MISUSE;
  sqlite3_int64 shmMaximum =
      ((regions + perMap - 1) / perMap) * perMap * BRC38_SHM_REGION;
  return brc38QuotaConfigure(q, root, originalMaximum, shmMaximum,
                             walletMaximum, expected, 0);
}

/* Private stage owns exactly the already admitted stage/owner families in
 * DELETE mode. Its source-page formula and aggregate allowance are unchanged.
 * Enrollment checks descriptors only; authentication/receiver admission is
 * still required by the actual private owner above the transport. */
static int brc38StageQuotaInitialize(Brc38Quota *q, const char *root,
                                     sqlite3_int64 originalMaximum,
                                     const Brc38ProfileEnrollment *expected) {
  if (!expected || originalMaximum < 1048576 ||
      originalMaximum > ((sqlite3_int64)9007199254740991))
    return SQLITE_MISUSE;
  sqlite3_int64 stagePages = (originalMaximum - 65536) / (3 * 4096);
  if (stagePages > ((sqlite3_int64)2147483646))
    stagePages = ((sqlite3_int64)2147483646);
  return brc38QuotaConfigure(q, root, originalMaximum, 0,
                             stagePages * 4096, expected, 1);
}
