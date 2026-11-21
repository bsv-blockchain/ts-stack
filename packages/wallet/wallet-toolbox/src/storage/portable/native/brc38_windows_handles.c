/* Private Windows file-identity/privacy component for the native VFS port.
 * Compile with the fixed SQLite amalgamation on Windows. These actual handle
 * checks do not authenticate an archive, grant a profile or prove a disk quota.
 * This is used by the Windows quota VFS; no runtime pin or qualification is claimed. */
#if !defined(_WIN32)
#error This component requires the native Windows file and security APIs
#endif
#include <windows.h>
#include <aclapi.h>
#include <stdint.h>
#include <wchar.h>

typedef struct Brc38WinFileIdentity {
  uint64_t device;
  uint64_t inode;
  uint64_t bytes;
} Brc38WinFileIdentity;

/* Dedicated-child native ownership, separate from a kernel-wide HANDLE limit.
 * Admission fixes the maximum once, before SQLite/profile creation. Every
 * file/token/mapping factory below owns an actual registry entry until actual
 * CloseHandle succeeds. The registry is never populated from caller numbers. */
static HANDLE brc38WinOwnedHandles[256];
static int brc38WinOwnedCount, brc38WinOwnedMaximum;
static int brc38WinCanOpen(void) {
  return brc38WinOwnedMaximum >= 16 && brc38WinOwnedCount < brc38WinOwnedMaximum;
}
static HANDLE brc38WinRecordHandle(HANDLE handle) {
  if (handle != NULL && handle != INVALID_HANDLE_VALUE)
    brc38WinOwnedHandles[brc38WinOwnedCount++] = handle;
  return handle;
}
static int brc38WinOwnsHandle(HANDLE handle) {
  for (int i = 0; i < brc38WinOwnedCount; i++) if (brc38WinOwnedHandles[i] == handle) return 1;
  return 0;
}
static BOOL WINAPI brc38WinPhysicalClose(HANDLE handle) {
  int index = -1;
  for (int i = 0; i < brc38WinOwnedCount; i++) if (brc38WinOwnedHandles[i] == handle) { index = i; break; }
  if (index < 0) { SetLastError(ERROR_INVALID_HANDLE); return FALSE; }
  if (!CloseHandle(handle)) return FALSE;
  brc38WinOwnedHandles[index] = brc38WinOwnedHandles[--brc38WinOwnedCount];
  return TRUE;
}
static HANDLE brc38WinOpenFile(LPCWSTR path, DWORD access, DWORD share,
    LPSECURITY_ATTRIBUTES attributes, DWORD disposition, DWORD flags, HANDLE templateFile) {
  if (!brc38WinCanOpen()) { SetLastError(ERROR_TOO_MANY_OPEN_FILES); return INVALID_HANDLE_VALUE; }
  return brc38WinRecordHandle(CreateFileW(path, access, share, attributes, disposition, flags, templateFile));
}
static BOOL brc38WinOpenToken(HANDLE *token) {
  if (!brc38WinCanOpen()) { SetLastError(ERROR_TOO_MANY_OPEN_FILES); return FALSE; }
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token)) return FALSE;
  brc38WinRecordHandle(*token); return TRUE;
}

/* Retain the actual failed cleanup resources, rather than losing handles or
 * pretending a failed CloseHandle/LocalFree released them. Fresh file checks
 * refuse until these original resources have physically drained. */
static HANDLE brc38WinRetainedHandles[4];
static HLOCAL brc38WinRetainedSecurity[2];
static int brc38WinHandleCount, brc38WinSecurityCount;

int brc38WinDrainFileCheckResources(void) {
  int rc = SQLITE_OK;
  for (int index = brc38WinHandleCount - 1; index >= 0; index--) {
    if (brc38WinPhysicalClose(brc38WinRetainedHandles[index])) {
      brc38WinRetainedHandles[index] = brc38WinRetainedHandles[--brc38WinHandleCount];
    } else rc = SQLITE_IOERR;
  }
  for (int index = brc38WinSecurityCount - 1; index >= 0; index--) {
    if (LocalFree(brc38WinRetainedSecurity[index]) == NULL) {
      brc38WinRetainedSecurity[index] = brc38WinRetainedSecurity[--brc38WinSecurityCount];
    } else rc = SQLITE_IOERR;
  }
  return rc;
}

/* Only a fresh single-threaded native check may enter these fixed slots. */
static int brc38WinReleaseHandle(HANDLE handle) {
  if (brc38WinPhysicalClose(handle)) return SQLITE_OK;
  if (brc38WinHandleCount >= 4) return SQLITE_MISUSE;
  brc38WinRetainedHandles[brc38WinHandleCount++] = handle;
  return SQLITE_IOERR;
}
static int brc38WinReleaseSecurity(PSECURITY_DESCRIPTOR descriptor) {
  if (LocalFree(descriptor) == NULL) return SQLITE_OK;
  if (brc38WinSecurityCount >= 2) return SQLITE_MISUSE;
  brc38WinRetainedSecurity[brc38WinSecurityCount++] = descriptor;
  return SQLITE_IOERR;
}

static int brc38WinTrustedSid(PSID sid, PSID user, PSID system, PSID administrators) {
  return IsValidSid(sid) && (EqualSid(sid, user) || EqualSid(sid, system) || EqualSid(sid, administrators));
}

/* Query the actual object's DACL and current process token. POSIX chmod bits,
 * a pathname ACL report or a caller-supplied owner SID never substitute for it.
 * Only the wallet actor, LocalSystem and local Administrators may receive data
 * or mutation rights. Unknown ACE forms refuse instead of being ignored. */
static int brc38WinPrivateSecurity(HANDLE file) {
  HANDLE token = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL acl = NULL;
  union { TOKEN_USER aligned; unsigned char bytes[1024]; } actor;
  unsigned char system[SECURITY_MAX_SID_SIZE], administrators[SECURITY_MAX_SID_SIZE];
  DWORD actorBytes = 0, systemBytes = sizeof(system), adminBytes = sizeof(administrators);
  int rc = SQLITE_AUTH;
  if (!brc38WinOpenToken(&token)) return SQLITE_IOERR;
  if (!GetTokenInformation(token, TokenUser, &actor, sizeof(actor), &actorBytes) ||
      actorBytes > sizeof(actor) || actorBytes < sizeof(TOKEN_USER) ||
      !IsValidSid(actor.aligned.User.Sid) ||
      !CreateWellKnownSid(WinLocalSystemSid, NULL, system, &systemBytes) ||
      !CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, administrators, &adminBytes)) goto done;
  if (GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                      &owner, NULL, &acl, NULL, &descriptor) != ERROR_SUCCESS ||
      !descriptor || GetSecurityDescriptorLength(descriptor) > 65536 ||
      !owner || !IsValidSid(owner) || !EqualSid(owner, actor.aligned.User.Sid) ||
      !acl || !IsValidAcl(acl) || acl->AceCount > 128) goto done;
  for (DWORD index = 0; index < acl->AceCount; index++) {
    ACE_HEADER *header = NULL;
    if (!GetAce(acl, index, (void **)&header) || !header ||
        header->AceSize < sizeof(ACCESS_ALLOWED_ACE) ||
        (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE)) goto done;
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
    PSID sid = &ace->SidStart;
    /* Validate the SID's extent before letting the SID APIs read its parts. */
    size_t offset = (size_t)((unsigned char *)sid - (unsigned char *)header);
    if (offset > header->AceSize || header->AceSize - offset < 8 ||
        ((SID *)sid)->SubAuthorityCount > SID_MAX_SUB_AUTHORITIES ||
        8U + 4U * ((SID *)sid)->SubAuthorityCount > header->AceSize - offset || !IsValidSid(sid)) goto done;
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Mask != 0 &&
        !brc38WinTrustedSid(sid, actor.aligned.User.Sid, system, administrators)) goto done;
  }
  rc = SQLITE_OK;
done:
  if (descriptor && brc38WinReleaseSecurity(descriptor) != SQLITE_OK) rc = SQLITE_IOERR;
  if (brc38WinReleaseHandle(token) != SQLITE_OK) rc = SQLITE_IOERR;
  return rc;
}

/* The original HANDLE remains owned by its caller. This checks that handle,
 * never another file opened by its name. Remote, reparse, alternate-volume,
 * multi-link and unsupported filesystems refuse the native local component. */
static int brc38WinPhysicalFileIdentity(HANDLE file, int directory, Brc38WinFileIdentity *identity) {
  BY_HANDLE_FILE_INFORMATION info;
  FILE_ATTRIBUTE_TAG_INFO tags;
  wchar_t filesystem[16], actualPath[4096], drive[4];
  DWORD flags = 0, length;
  if (brc38WinHandleCount || brc38WinSecurityCount || !identity ||
      (directory != 0 && directory != 1) || file == INVALID_HANDLE_VALUE || file == NULL ||
      GetFileType(file) != FILE_TYPE_DISK ||
      !GetFileInformationByHandle(file, &info) ||
      !GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tags, sizeof(tags)) ||
      (tags.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !!(tags.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory ||
      (!directory && info.nNumberOfLinks != 1)) return SQLITE_IOERR;
  if (!GetVolumeInformationByHandleW(file, NULL, 0, NULL, NULL, &flags, filesystem,
                                    sizeof(filesystem) / sizeof(filesystem[0])) ||
      wcscmp(filesystem, L"NTFS") || !(flags & FILE_PERSISTENT_ACLS)) return SQLITE_IOERR;
  length = GetFinalPathNameByHandleW(file, actualPath,
      sizeof(actualPath) / sizeof(actualPath[0]), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length < 7 || length >= sizeof(actualPath) / sizeof(actualPath[0]) ||
      wcsncmp(actualPath, L"\\\\?\\", 4) ||
      !((actualPath[4] >= L'A' && actualPath[4] <= L'Z') || (actualPath[4] >= L'a' && actualPath[4] <= L'z')) ||
      actualPath[5] != L':' || actualPath[6] != L'\\') return SQLITE_IOERR;
  drive[0] = actualPath[4]; drive[1] = L':'; drive[2] = L'\\'; drive[3] = 0;
  if (GetDriveTypeW(drive) != DRIVE_FIXED) return SQLITE_IOERR;
  identity->device = info.dwVolumeSerialNumber;
  identity->inode = ((uint64_t)info.nFileIndexHigh << 32) | info.nFileIndexLow;
  identity->bytes = ((uint64_t)info.nFileSizeHigh << 32) | info.nFileSizeLow;
  return SQLITE_OK;
}
int brc38WinPrivateFileIdentity(HANDLE file, int directory, Brc38WinFileIdentity *identity) {
  int rc = brc38WinPhysicalFileIdentity(file, directory, identity);
  return rc == SQLITE_OK ? brc38WinPrivateSecurity(file) : rc;
}

/* Supply a protected actor-only DACL at creation, before any private bytes
 * exist. Directory ACE inheritance also protects ordinary Node-created child
 * files; each actual file is still checked independently before use. */
#if !defined(BRC38_WIN_METADATA_ONLY)
typedef struct Brc38WinCreation {
  union { TOKEN_USER aligned; unsigned char bytes[1024]; } actor;
  union { ACL aligned; unsigned char bytes[1024]; } permissions;
  SECURITY_DESCRIPTOR descriptor;
  SECURITY_ATTRIBUTES attributes;
} Brc38WinCreation;
static int brc38WinCreationSecurity(Brc38WinCreation *creation, int directory) {
  HANDLE token = NULL; DWORD actorBytes = 0;
  if (brc38WinHandleCount || brc38WinSecurityCount || !brc38WinOpenToken(&token)) return SQLITE_IOERR;
  int ready = GetTokenInformation(token, TokenUser, &creation->actor, sizeof(creation->actor), &actorBytes) &&
      actorBytes >= sizeof(TOKEN_USER) && actorBytes <= sizeof(creation->actor) &&
      IsValidSid(creation->actor.aligned.User.Sid) &&
      InitializeAcl(&creation->permissions.aligned, sizeof(creation->permissions), ACL_REVISION) &&
      AddAccessAllowedAceEx(&creation->permissions.aligned, ACL_REVISION,
          directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0,
          FILE_ALL_ACCESS, creation->actor.aligned.User.Sid) &&
      InitializeSecurityDescriptor(&creation->descriptor, SECURITY_DESCRIPTOR_REVISION) &&
      SetSecurityDescriptorOwner(&creation->descriptor, creation->actor.aligned.User.Sid, FALSE) &&
      SetSecurityDescriptorDacl(&creation->descriptor, TRUE, &creation->permissions.aligned, FALSE) &&
      SetSecurityDescriptorControl(&creation->descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED);
  if (brc38WinReleaseHandle(token) != SQLITE_OK || !ready) return SQLITE_IOERR;
  creation->attributes.nLength = sizeof(creation->attributes);
  creation->attributes.lpSecurityDescriptor = &creation->descriptor;
  creation->attributes.bInheritHandle = FALSE;
  return SQLITE_OK;
}
static HANDLE brc38WinCreatePrivateFile(LPCWSTR name, DWORD access, DWORD share,
                                      DWORD disposition, DWORD flags) {
  Brc38WinCreation creation;
  if (brc38WinCreationSecurity(&creation, 0) != SQLITE_OK) {
    SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE;
  }
  return brc38WinOpenFile(name, access | READ_CONTROL, share, &creation.attributes, disposition,
                         flags | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
}
int brc38WinCreatePrivateDirectory(LPCWSTR name) {
  Brc38WinCreation creation;
  if (brc38WinCreationSecurity(&creation, 1) != SQLITE_OK) { SetLastError(ERROR_ACCESS_DENIED); return SQLITE_IOERR; }
  return CreateDirectoryW(name, &creation.attributes) ? SQLITE_OK : SQLITE_IOERR;
}
#endif
