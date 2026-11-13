/* Node-API Windows physical file boundary. This library checks actual OS
 * objects and creates private DACLs; it never admits an archive/profile or
 * changes the Node host's kernel process/memory limits. Compile against the
 * exact qualified Node headers/import library and Windows SDK. */
#if !defined(_WIN32)
#error This Node physical boundary requires Windows
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#include <node_api.h>
#include <uv.h>
#include <stdio.h>
#include <string.h>
#include <stdbool.h>
#include <stdlib.h>
#include <limits.h>
#define SQLITE_OK 0
#define SQLITE_IOERR 10
#define SQLITE_MISUSE 21
#define SQLITE_AUTH 23
#include "brc38_windows_handles.c"
#define BRC38_WIN_PATH_MAX 4096
static DWORD bridgeThread;
static int bridgeImagePending(void);

static napi_value bridgeFailureWithCode(napi_env env, const char *message, DWORD win32Code) {
  napi_value code, text, error, nativeCode;
  const char *label = brc38WinHandleCount || brc38WinSecurityCount || bridgeImagePending() ?
      "BRC38_WINDOWS_CLEANUP_RETAINED" : "BRC38_WINDOWS_PRIVATE_FILE_REFUSED";
  if (napi_create_string_utf8(env, label, NAPI_AUTO_LENGTH, &code) != napi_ok ||
      napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_error(env, code, text, &error) != napi_ok ||
      napi_create_uint32(env, win32Code, &nativeCode) != napi_ok) return NULL;
  napi_property_descriptor detail = {"win32Code", NULL, NULL, NULL, NULL, nativeCode, napi_enumerable, NULL};
  if (napi_define_properties(env, error, 1, &detail) != napi_ok || napi_throw(env, error) != napi_ok) return NULL;
  return NULL;
}
static napi_value bridgeFailure(napi_env env, const char *message) {
  return bridgeFailureWithCode(env, message, 0);
}
static int bridgePath(napi_env env, napi_value value, wchar_t *path) {
  char utf8[BRC38_WIN_PATH_MAX]; size_t bytes = 0;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &bytes) != napi_ok ||
      bytes < 4 || bytes >= sizeof(utf8) ||
      napi_get_value_string_utf8(env, value, utf8, sizeof(utf8), &bytes) != napi_ok ||
      memchr(utf8, 0, bytes) ||
      !((utf8[0] >= 'A' && utf8[0] <= 'Z') || (utf8[0] >= 'a' && utf8[0] <= 'z')) ||
      utf8[1] != ':' || (utf8[2] != '/' && utf8[2] != '\\') || strchr(utf8 + 2, ':')) return 0;
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, path, BRC38_WIN_PATH_MAX) > 0;
}
static int bridgeArguments(napi_env env, napi_callback_info info, napi_value *args, size_t expected) {
  size_t count = 3;
  return GetCurrentThreadId() == bridgeThread &&
      napi_get_cb_info(env, info, &count, args, NULL, NULL) == napi_ok && count == expected;
}
static napi_value bridgeIdentity(napi_env env, const Brc38WinFileIdentity *identity) {
  napi_value result, valuesNative[3];
  char text[32];
  if (napi_create_object(env, &result) != napi_ok) return bridgeFailure(env, "Physical identity allocation failed");
  const char *names[3] = {"device", "inode", "bytes"};
  const uint64_t values[3] = {identity->device, identity->inode, identity->bytes};
  for (int i = 0; i < 3; i++) {
    int length = snprintf(text, sizeof(text), "%llu", (unsigned long long)values[i]);
    if (length < 1 || length >= (int)sizeof(text) ||
        napi_create_string_utf8(env, text, (size_t)length, &valuesNative[i]) != napi_ok)
      return bridgeFailure(env, "Physical identity allocation failed");
  }
  napi_property_descriptor properties[3];
  memset(properties, 0, sizeof(properties));
  for (int i = 0; i < 3; i++) {
    properties[i].utf8name = names[i]; properties[i].value = valuesNative[i];
    properties[i].attributes = napi_enumerable;
  }
  if (napi_define_properties(env, result, 3, properties) != napi_ok)
    return bridgeFailure(env, "Physical identity allocation failed");
  return result;
}
static napi_value bridgeInspectPath(napi_env env, napi_callback_info info) {
  napi_value args[3]; bool directory; wchar_t path[BRC38_WIN_PATH_MAX];
  if (!bridgeArguments(env, info, args, 2) || !bridgePath(env, args[0], path) ||
      napi_get_value_bool(env, args[1], &directory) != napi_ok)
    return bridgeFailure(env, "Private path arguments differ");
  HANDLE file = brc38WinOpenFile(path, FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), NULL);
  if (file == INVALID_HANDLE_VALUE) return bridgeFailure(env, "Actual private path could not be opened");
  Brc38WinFileIdentity identity;
  int rc = brc38WinPrivateFileIdentity(file, directory, &identity);
  if (brc38WinReleaseHandle(file) != SQLITE_OK) rc = SQLITE_IOERR;
  if (rc != SQLITE_OK) return bridgeFailure(env, "Actual path identity or DACL refused");
  return bridgeIdentity(env, &identity);
}
/* uv_get_osfhandle delegates to the CRT. A closed/invalid descriptor is a
 * recoverable metadata refusal, not a reason to terminate the Node host. This
 * thread-local handler exists only around that synchronous call and restores
 * the original handler before any SDK or Node callback. Build with /MD against
 * the same UCRT as Node; no process-global handler is changed. */
static void __cdecl bridgeInvalidDescriptor(const wchar_t *expression, const wchar_t *function,
    const wchar_t *file, unsigned int line, uintptr_t reserved) {
  (void)expression; (void)function; (void)file; (void)line; (void)reserved;
}
static napi_value bridgeInspectDescriptor(napi_env env, napi_callback_info info) {
  napi_value args[3]; int32_t fd; double original; bool directory;
  if (!bridgeArguments(env, info, args, 2) || napi_get_value_int32(env, args[0], &fd) != napi_ok ||
      fd < 0 || napi_get_value_double(env, args[0], &original) != napi_ok ||
      original != (double)fd || napi_get_value_bool(env, args[1], &directory) != napi_ok)
    return bridgeFailure(env, "Original descriptor arguments differ");
  /* libuv supplies the real HANDLE for the original Node FileHandle. This
   * function never closes, duplicates or assumes ownership of that descriptor. */
  _invalid_parameter_handler previous = _set_thread_local_invalid_parameter_handler(bridgeInvalidDescriptor);
  HANDLE file = (HANDLE)uv_get_osfhandle(fd);
  _set_thread_local_invalid_parameter_handler(previous);
  Brc38WinFileIdentity identity;
  if (brc38WinPrivateFileIdentity(file, directory, &identity) != SQLITE_OK)
    return bridgeFailure(env, "Original descriptor identity or DACL refused");
  return bridgeIdentity(env, &identity);
}
static napi_value bridgeCreateDirectory(napi_env env, napi_callback_info info) {
  napi_value args[3]; wchar_t path[BRC38_WIN_PATH_MAX];
  if (!bridgeArguments(env, info, args, 1) || !bridgePath(env, args[0], path))
    return bridgeFailure(env, "Private directory arguments differ");
  if (brc38WinCreatePrivateDirectory(path) != SQLITE_OK)
    return bridgeFailureWithCode(env, "Private directory creation refused", GetLastError());
  HANDLE file = brc38WinOpenFile(path, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return bridgeFailure(env, "Created private directory could not be opened");
  Brc38WinFileIdentity identity;
  int rc = brc38WinPrivateFileIdentity(file, 1, &identity);
  if (brc38WinReleaseHandle(file) != SQLITE_OK) rc = SQLITE_IOERR;
  if (rc != SQLITE_OK) return bridgeFailure(env, "Created directory identity or DACL refused");
  return bridgeIdentity(env, &identity);
}
static napi_value bridgeCreateFile(napi_env env, napi_callback_info info) {
  napi_value args[3]; wchar_t path[BRC38_WIN_PATH_MAX];
  if (!bridgeArguments(env, info, args, 1) || !bridgePath(env, args[0], path))
    return bridgeFailure(env, "Private file arguments differ");
  HANDLE file = brc38WinCreatePrivateFile(path, GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ, CREATE_NEW, FILE_ATTRIBUTE_NORMAL);
  if (file == INVALID_HANDLE_VALUE) return bridgeFailureWithCode(env, "Exclusive private file creation refused", GetLastError());
  Brc38WinFileIdentity identity;
  int rc = brc38WinPrivateFileIdentity(file, 0, &identity);
  if (brc38WinReleaseHandle(file) != SQLITE_OK) rc = SQLITE_IOERR;
  if (rc != SQLITE_OK) return bridgeFailure(env, "Created file identity or DACL refused");
  return bridgeIdentity(env, &identity);
}
#include "windows_image.c"
static napi_value bridgeDrain(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  if (!bridgeArguments(env, info, args, 0) || brc38WinDrainFileCheckResources() != SQLITE_OK ||
      bridgeImageDrain() != SQLITE_OK)
    return bridgeFailure(env, "Original private boundary resources remain owned");
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
static napi_value bridgeInitialize(napi_env env, napi_value exports) {
  /* One original Node thread only. Four image owners have at most33 retained
   * handles each, plus bounded temporary metadata/token handles. This is an
   * addon-owned registry, not a kernel-wide limit on the Node host. */
  if (bridgeThread) return bridgeFailure(env, "Private boundary is already owned by its original Node thread");
  bridgeThread = GetCurrentThreadId(); brc38WinOwnedMaximum = 160;
  napi_property_descriptor properties[] = {
    {"inspectPath", NULL, bridgeInspectPath, NULL, NULL, NULL, napi_default, NULL},
    {"inspectDescriptor", NULL, bridgeInspectDescriptor, NULL, NULL, NULL, napi_default, NULL},
    {"createDirectory", NULL, bridgeCreateDirectory, NULL, NULL, NULL, napi_default, NULL},
    {"createFile", NULL, bridgeCreateFile, NULL, NULL, NULL, napi_default, NULL},
    {"retryCleanup", NULL, bridgeDrain, NULL, NULL, NULL, napi_default, NULL},
    {"acquireImage", NULL, bridgeAcquireImage, NULL, NULL, NULL, napi_default, NULL},
    {"checkImage", NULL, bridgeCheckImage, NULL, NULL, NULL, napi_default, NULL},
    {"releaseImage", NULL, bridgeReleaseImage, NULL, NULL, NULL, napi_default, NULL}
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok)
    return bridgeFailure(env, "Private boundary exports failed");
  return exports;
}
NAPI_MODULE(brc38_windows, bridgeInitialize)
