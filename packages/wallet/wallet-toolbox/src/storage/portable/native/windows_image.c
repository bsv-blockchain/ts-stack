/* Included by windows_bridge.c, not the SQLite child. Protect the original
 * installed image and every pathname ancestor through actual child exit.
 * No caller-provided ACL/identity or candidate receipt registers an image. */
#include <shlobj.h>
#include <sddl.h>
#include <stddef.h>
#define BRC38_IMAGE_OWNERS 4
#define BRC38_IMAGE_ANCESTORS 32
typedef struct BridgeImage {
  HANDLE handles[BRC38_IMAGE_ANCESTORS + 1];
  int count, active, failed;
  void *token;
  unsigned int generation;
  Brc38WinFileIdentity identity;
} BridgeImage;
typedef struct BridgeImageToken { BridgeImage *owner; unsigned int generation; } BridgeImageToken;
static BridgeImage bridgeImages[BRC38_IMAGE_OWNERS];

static int bridgeImagePending(void) {
  for (int i = 0; i < BRC38_IMAGE_OWNERS; i++) if (bridgeImages[i].failed) return 1;
  return 0;
}
static int bridgeImageClose(BridgeImage *owner) {
  int rc = SQLITE_OK;
  for (int i = owner->count - 1; i >= 0; i--) {
    if (brc38WinPhysicalClose(owner->handles[i])) {
      owner->handles[i] = owner->handles[--owner->count];
    } else rc = SQLITE_IOERR;
  }
  if (!owner->count) { owner->active = 0; owner->failed = 0; owner->token = NULL; }
  else owner->failed = 1;
  return rc;
}
static int bridgeImageDrain(void) {
  int rc = SQLITE_OK;
  for (int i = 0; i < BRC38_IMAGE_OWNERS; i++)
    if (bridgeImages[i].failed && bridgeImageClose(&bridgeImages[i]) != SQLITE_OK) rc = SQLITE_IOERR;
  return rc;
}

/* Both the object's owner and every effective mutation ACE must belong to
 * the OS installation administrators. Then independently ask AccessCheck
 * about the actual process token: a privileged/writable wallet host refuses.
 * Read-only ACEs may belong to ordinary users. Unknown ACE forms refuse. */
static int bridgeImageSecurity(HANDLE file, int driveRoot) {
  HANDLE processToken = NULL, actor = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL, installer = NULL;
  PACL acl = NULL;
  union { SID aligned; unsigned char bytes[SECURITY_MAX_SID_SIZE]; } system, admin;
  union { PRIVILEGE_SET aligned; unsigned char bytes[4096]; } privileges;
  union { TOKEN_PRIVILEGES aligned; unsigned char bytes[4096]; } tokenPrivileges;
  DWORD systemBytes = sizeof(system), adminBytes = sizeof(admin), privilegeBytes = sizeof(privileges), granted = 0;
  BOOL access = FALSE;
  GENERIC_MAPPING mapping = { FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
  /* Creating a different folder in the drive root cannot replace our locked
   * existing ancestry. Every installed directory still prohibits such rights. */
  const DWORD mutation = DELETE | WRITE_DAC | WRITE_OWNER | FILE_WRITE_DATA |
      (driveRoot ? 0 : FILE_APPEND_DATA) | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD;
  int rc = SQLITE_AUTH;
  if (brc38WinHandleCount || brc38WinSecurityCount || !brc38WinCanOpen() ||
      !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &processToken)) return SQLITE_IOERR;
  brc38WinRecordHandle(processToken);
  DWORD tokenBytes = 0;
  if (!GetTokenInformation(processToken, TokenPrivileges, &tokenPrivileges, sizeof(tokenPrivileges), &tokenBytes) ||
      tokenBytes > sizeof(tokenPrivileges) || tokenBytes < offsetof(TOKEN_PRIVILEGES, Privileges) ||
      tokenPrivileges.aligned.PrivilegeCount >
        (tokenBytes - offsetof(TOKEN_PRIVILEGES, Privileges)) / sizeof(LUID_AND_ATTRIBUTES)) goto done;
  const wchar_t *dangerous[] = { SE_RESTORE_NAME, SE_TAKE_OWNERSHIP_NAME, SE_BACKUP_NAME, SE_SECURITY_NAME, SE_DEBUG_NAME };
  for (size_t i = 0; i < sizeof(dangerous) / sizeof(dangerous[0]); i++) {
    LUID privilege;
    if (!LookupPrivilegeValueW(NULL, dangerous[i], &privilege)) goto done;
    for (DWORD j = 0; j < tokenPrivileges.aligned.PrivilegeCount; j++) {
      const LUID_AND_ATTRIBUTES *actual = &tokenPrivileges.aligned.Privileges[j];
      if (actual->Luid.LowPart == privilege.LowPart && actual->Luid.HighPart == privilege.HighPart &&
          (actual->Attributes & SE_PRIVILEGE_ENABLED)) goto done;
    }
  }
  if (!brc38WinCanOpen() || !DuplicateToken(processToken, SecurityImpersonation, &actor)) goto done;
  brc38WinRecordHandle(actor);
  if (!CreateWellKnownSid(WinLocalSystemSid, NULL, &system, &systemBytes) ||
      !CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, &admin, &adminBytes) ||
      !ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &installer) ||
      GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
          &owner, NULL, &acl, NULL, &descriptor) != ERROR_SUCCESS ||
      !descriptor || GetSecurityDescriptorLength(descriptor) > 65536 || !owner || !IsValidSid(owner) ||
      !brc38WinTrustedSid(owner, installer, &system, &admin) || !acl || !IsValidAcl(acl) || acl->AceCount > 128) goto done;
  for (DWORD i = 0; i < acl->AceCount; i++) {
    ACE_HEADER *header = NULL;
    if (!GetAce(acl, i, (void **)&header) || !header || header->AceSize < sizeof(ACCESS_ALLOWED_ACE) ||
        (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE)) goto done;
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
    PSID sid = &ace->SidStart;
    size_t offset = (size_t)((unsigned char *)sid - (unsigned char *)header);
    if (offset > header->AceSize || header->AceSize - offset < 8 ||
        ((SID *)sid)->SubAuthorityCount > SID_MAX_SUB_AUTHORITIES ||
        8U + 4U * ((SID *)sid)->SubAuthorityCount > header->AceSize - offset || !IsValidSid(sid)) goto done;
    DWORD mask = ace->Mask;
    MapGenericMask(&mask, &mapping);
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE && !(header->AceFlags & INHERIT_ONLY_ACE) &&
        (mask & mutation) && !brc38WinTrustedSid(sid, installer, &system, &admin)) goto done;
  }
  if (!AccessCheck(descriptor, actor, MAXIMUM_ALLOWED, &mapping, &privileges.aligned,
      &privilegeBytes, &granted, &access) || !access || privilegeBytes > sizeof(privileges) ||
      (granted & mutation)) goto done;
  rc = SQLITE_OK;
done:
  if (descriptor && brc38WinReleaseSecurity(descriptor) != SQLITE_OK) rc = SQLITE_IOERR;
  if (installer && brc38WinReleaseSecurity((PSECURITY_DESCRIPTOR)installer) != SQLITE_OK) rc = SQLITE_IOERR;
  if (actor && brc38WinReleaseHandle(actor) != SQLITE_OK) rc = SQLITE_IOERR;
  if (brc38WinReleaseHandle(processToken) != SQLITE_OK) rc = SQLITE_IOERR;
  return rc;
}
static void bridgeImageFinalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  BridgeImageToken *token = (BridgeImageToken *)data;
  if (token && token->owner->active && token->owner->generation == token->generation)
    (void)bridgeImageClose(token->owner);
  free(token);
}
static BridgeImage *bridgeImageOwner(napi_env env, napi_value value) {
  void *data = NULL;
  if (napi_get_value_external(env, value, &data) != napi_ok || !data) return NULL;
  /* Compare the original pointer before dereferencing: another addon may
   * expose an unrelated external, and a previous token may already be closed. */
  for (int i = 0; i < BRC38_IMAGE_OWNERS; i++) if (bridgeImages[i].token == data && bridgeImages[i].active) {
    BridgeImageToken *token = (BridgeImageToken *)data;
    if (token->generation == bridgeImages[i].generation) return &bridgeImages[i];
  }
  return NULL;
}
static napi_value bridgeAcquireImage(napi_env env, napi_callback_info info) {
  napi_value args[3], result; wchar_t path[BRC38_WIN_PATH_MAX], normalized[BRC38_WIN_PATH_MAX], root[MAX_PATH];
  int32_t fd; double supplied;
  if (!bridgeArguments(env, info, args, 2) || !bridgePath(env, args[0], path) ||
      napi_get_value_int32(env, args[1], &fd) != napi_ok || fd < 0 ||
      napi_get_value_double(env, args[1], &supplied) != napi_ok || supplied != (double)fd ||
      bridgeImagePending() || brc38WinHandleCount || brc38WinSecurityCount)
    return bridgeFailure(env, "Installed image acquisition refused");
  for (wchar_t *p = path; *p; p++) if (*p == L'/') *p = L'\\';
  DWORD length = GetFullPathNameW(path, BRC38_WIN_PATH_MAX, normalized, NULL);
  if (!length || length >= BRC38_WIN_PATH_MAX || _wcsicmp(path, normalized) ||
      SHGetFolderPathW(NULL, CSIDL_PROGRAM_FILES, NULL, SHGFP_TYPE_CURRENT, root) != S_OK)
    return bridgeFailure(env, "Installed image pathname differs");
  size_t rootLength = wcslen(root);
  const wchar_t *suffix = L"\\BSV Wallet\\native\\";
  if (_wcsnicmp(path, root, rootLength) || _wcsnicmp(path + rootLength, suffix, wcslen(suffix)) ||
      !path[rootLength + wcslen(suffix)]) return bridgeFailure(env, "Installed image is outside its fixed installation");
  BridgeImage *owner = NULL;
  for (int i = 0; i < BRC38_IMAGE_OWNERS; i++) if (!bridgeImages[i].active) { owner = &bridgeImages[i]; break; }
  if (!owner || owner->generation == UINT_MAX) return bridgeFailure(env, "Installed image owners are exhausted");
  owner->active = 1; owner->failed = 0; owner->count = 0; owner->generation++;
  int directory = 0, rc = SQLITE_OK;
  for (;;) {
    if (owner->count >= BRC38_IMAGE_ANCESTORS + 1) { rc = SQLITE_AUTH; break; }
    HANDLE handle = brc38WinOpenFile(normalized, FILE_READ_ATTRIBUTES | READ_CONTROL,
        directory ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), NULL);
    if (handle == INVALID_HANDLE_VALUE) { rc = SQLITE_IOERR; break; }
    owner->handles[owner->count++] = handle;
    Brc38WinFileIdentity identity;
    if (brc38WinPhysicalFileIdentity(handle, directory, &identity) != SQLITE_OK ||
        bridgeImageSecurity(handle, wcslen(normalized) == 3) != SQLITE_OK) { rc = SQLITE_AUTH; break; }
    wchar_t actual[BRC38_WIN_PATH_MAX];
    DWORD actualLength = GetFinalPathNameByHandleW(handle, actual, BRC38_WIN_PATH_MAX, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (actualLength < 7 || actualLength >= BRC38_WIN_PATH_MAX || _wcsicmp(actual + 4, normalized)) { rc = SQLITE_AUTH; break; }
    if (!directory) owner->identity = identity;
    if (wcslen(normalized) == 3) break;
    wchar_t *separator = wcsrchr(normalized, L'\\');
    if (!separator || separator < normalized + 2) { rc = SQLITE_AUTH; break; }
    if (separator == normalized + 2) separator[1] = 0; else *separator = 0;
    directory = 1;
  }
  _invalid_parameter_handler previous = _set_thread_local_invalid_parameter_handler(bridgeInvalidDescriptor);
  HANDLE borrowed = (HANDLE)uv_get_osfhandle(fd);
  _set_thread_local_invalid_parameter_handler(previous);
  Brc38WinFileIdentity original;
  if (rc == SQLITE_OK && (brc38WinPhysicalFileIdentity(borrowed, 0, &original) != SQLITE_OK ||
      original.device != owner->identity.device || original.inode != owner->identity.inode ||
      original.bytes != owner->identity.bytes)) rc = SQLITE_AUTH;
  BridgeImageToken *token = rc == SQLITE_OK ? (BridgeImageToken *)calloc(1, sizeof(*token)) : NULL;
  if (!token) rc = SQLITE_IOERR;
  if (rc == SQLITE_OK) {
    token->owner = owner; token->generation = owner->generation;
    owner->token = token;
    if (napi_create_external(env, token, bridgeImageFinalize, NULL, &result) == napi_ok) return result;
    owner->token = NULL; free(token);
  }
  owner->failed = 1; (void)bridgeImageClose(owner);
  return bridgeFailure(env, "Actual installed image/ancestor handles refused");
}
static napi_value bridgeCheckImage(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  if (!bridgeArguments(env, info, args, 1)) return bridgeFailure(env, "Installed image token differs");
  BridgeImage *owner = bridgeImageOwner(env, args[0]);
  if (!owner || owner->failed || bridgeImagePending()) return bridgeFailure(env, "Installed image is no longer retained");
  for (int i = 0; i < owner->count; i++) {
    Brc38WinFileIdentity current;
    if (!brc38WinOwnsHandle(owner->handles[i]) ||
        brc38WinPhysicalFileIdentity(owner->handles[i], i != 0, &current) != SQLITE_OK ||
        bridgeImageSecurity(owner->handles[i], i == owner->count - 1) != SQLITE_OK ||
        (!i && (current.device != owner->identity.device || current.inode != owner->identity.inode || current.bytes != owner->identity.bytes)))
      return bridgeFailure(env, "Actual installed image changed before launch");
  }
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
static napi_value bridgeReleaseImage(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  if (!bridgeArguments(env, info, args, 1)) return bridgeFailure(env, "Installed image release token differs");
  BridgeImage *owner = bridgeImageOwner(env, args[0]);
  if (!owner || bridgeImageClose(owner) != SQLITE_OK) return bridgeFailure(env, "Actual installed image cleanup remains owned");
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
