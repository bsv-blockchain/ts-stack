/* Maintainer compiler controller only. Bootstrap/qualify this exact source
 * inside a fresh isolated Windows worker before registering its fixed build.
 * brc38_build_policy.h binds the reviewed absolute cl/INCLUDE/LIB paths and
 * policy digest at compile time. No caller command line or environment selects
 * another compiler, flags, library search path or executable to run. */
#if !defined(_WIN32)
#error Windows build controller requires its original Windows worker
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <wchar.h>
#include <string.h>
#include "brc38_build_policy.h"
#define SQLITE_OK 0
#define SQLITE_IOERR 10
#define SQLITE_MISUSE 21
#define SQLITE_AUTH 23
#define BRC38_WIN_METADATA_ONLY
#include "brc38_windows_handles.c"

static int jobActive(HANDLE job, DWORD *active) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state;
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &state, sizeof(state), NULL)) return 0;
  *active = state.ActiveProcesses; return 1;
}
static int pump(HANDLE pipe, DWORD *total) {
  char buffer[4096]; DWORD available = 0, read = 0, written = 0;
  if (!PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL)) return GetLastError() == ERROR_BROKEN_PIPE;
  while (available) {
    DWORD amount = available < sizeof(buffer) ? available : sizeof(buffer);
    if (!ReadFile(pipe, buffer, amount, &read, NULL) || !read || read > 65536 - *total) return 0;
    *total += read;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), buffer, read, &written, NULL) || written != read) return 0;
    if (!PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL)) return GetLastError() == ERROR_BROKEN_PIPE;
  }
  return 1;
}
int wmain(int argc, wchar_t **argv) {
  if (argc != 3 || (wcscmp(argv[1], L"--driver") && wcscmp(argv[1], L"--addon"))) return 64;
  wchar_t directory[4096], windows[MAX_PATH], environment[32768], command[8192];
  DWORD length = GetFullPathNameW(argv[2], 4096, directory, NULL);
  if (!length || length >= 4096 || _wcsicmp(directory, argv[2]) || directory[1] != L':' ||
      directory[2] != L'\\' || !GetWindowsDirectoryW(windows, MAX_PATH)) return 65;
  const int addon = !wcscmp(argv[1], L"--addon");
  const wchar_t *flags = addon ?
    L"/nologo /O2 /std:c11 /W4 /WX /LD /MD /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0602 /DNAPI_VERSION=8 /Inode-headers windows_bridge.c node.lib /Fe:brc38_windows.node /link advapi32.lib shell32.lib" :
    L"/nologo /O2 /std:c11 /W4 /WX /MT /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0602 /DSQLITE_THREADSAFE=1 /DSQLITE_DEFAULT_MEMSTATUS=1 /DSQLITE_DQS=0 /I. native_driver.c /Fe:native-candidate.exe /link advapi32.lib psapi.lib";
  int count = _snwprintf_s(command, sizeof(command) / sizeof(command[0]), _TRUNCATE,
      L"\"%ls\" %ls", BRC38_BUILD_COMPILER, flags);
  if (count < 1) return 66;
  /* An explicit sorted environment excludes CL/_CL_/LINK and other injected
   * compiler flags. Temporary compiler output stays in this original root. */
  const wchar_t *names[] = {L"INCLUDE", L"LIB", L"PATH", L"SystemRoot", L"TEMP", L"TMP"};
  const wchar_t *values[] = {BRC38_BUILD_INCLUDE, BRC38_BUILD_LIB, BRC38_BUILD_PATH, windows, directory, directory};
  size_t at = 0;
  for (int i = 0; i < 6; i++) {
    int used = _snwprintf_s(environment + at, 32768 - at, _TRUNCATE, L"%ls=%ls", names[i], values[i]);
    if (used < 1) return 67;
    at += (size_t)used + 1;
  }
  if (at >= 32768) return 67;
  environment[at] = 0;
  brc38WinOwnedMaximum = 32;
  HANDLE root = brc38WinOpenFile(directory, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  Brc38WinFileIdentity rootIdentity;
  if (root == INVALID_HANDLE_VALUE || !brc38WinOwnsHandle(root) ||
      brc38WinPrivateFileIdentity(root, 1, &rootIdentity) != SQLITE_OK) return 68;
  HANDLE job = brc38WinRecordHandle(CreateJobObjectW(NULL, NULL)), readPipe = NULL, writePipe = NULL, input = INVALID_HANDLE_VALUE;
  PROCESS_INFORMATION child; memset(&child, 0, sizeof(child));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits; memset(&limits, 0, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
      JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_TIME;
  limits.ProcessMemoryLimit = 536870912; limits.JobMemoryLimit = 536870912;
  limits.BasicLimitInformation.ActiveProcessLimit = 4;
  limits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart = 1800000000;
  int failed = 0, attached = 0, attributesReady = 0;
  SECURITY_ATTRIBUTES inherit = {sizeof(inherit), NULL, TRUE};
  union { void *aligned; unsigned char bytes[4096]; } attributes; SIZE_T attributeBytes = 0;
  STARTUPINFOEXW start; memset(&start, 0, sizeof(start)); start.StartupInfo.cb = sizeof(start);
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !CreatePipe(&readPipe, &writePipe, &inherit, 4096)) { failed = 1; goto finish; }
  brc38WinRecordHandle(readPipe); brc38WinRecordHandle(writePipe);
  if (!SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0)) { failed = 1; goto finish; }
  input = brc38WinOpenFile(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, NULL);
  if (input == INVALID_HANDLE_VALUE) { failed = 1; goto finish; }
  (void)InitializeProcThreadAttributeList(NULL, 1, 0, &attributeBytes);
  if (!attributeBytes || attributeBytes > sizeof(attributes)) { failed = 1; goto finish; }
  start.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)attributes.bytes;
  if (!InitializeProcThreadAttributeList(start.lpAttributeList, 1, 0, &attributeBytes)) { failed = 1; goto finish; }
  attributesReady = 1;
  HANDLE inherited[] = {input, writePipe};
  if (!UpdateProcThreadAttribute(start.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      inherited, sizeof(inherited), NULL, NULL)) { failed = 1; goto finish; }
  start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  start.StartupInfo.hStdInput = input; start.StartupInfo.hStdOutput = writePipe; start.StartupInfo.hStdError = writePipe;
  if (!CreateProcessW(BRC38_BUILD_COMPILER, command, NULL, NULL, TRUE,
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
      environment, directory, &start.StartupInfo, &child)) { failed = 1; goto finish; }
  brc38WinRecordHandle(child.hProcess); brc38WinRecordHandle(child.hThread);
  if (!AssignProcessToJobObject(job, child.hProcess)) { failed = 1; goto finish; }
  attached = 1;
  BOOL member = FALSE; JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual;
  if (!IsProcessInJob(child.hProcess, job, &member) || !member ||
      !QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &actual, sizeof(actual), NULL) ||
      actual.BasicLimitInformation.LimitFlags != limits.BasicLimitInformation.LimitFlags ||
      actual.ProcessMemoryLimit != limits.ProcessMemoryLimit || actual.JobMemoryLimit != limits.JobMemoryLimit ||
      actual.BasicLimitInformation.ActiveProcessLimit != 4 ||
      actual.BasicLimitInformation.PerJobUserTimeLimit.QuadPart != 1800000000 ||
      ResumeThread(child.hThread) == (DWORD)-1) { failed = 1; goto finish; }
  if (!brc38WinPhysicalClose(writePipe)) { failed = 1; goto finish; }
  writePipe = NULL;
  ULONGLONG deadline = GetTickCount64() + 180000; DWORD total = 0, active = 0, exitCode = STILL_ACTIVE;
  for (;;) {
    if (!pump(readPipe, &total) || !jobActive(job, &active)) { failed = 1; break; }
    if (!active) break;
    if (GetTickCount64() >= deadline) { failed = 1; break; }
    Sleep(10);
  }
  if (!pump(readPipe, &total) || !GetExitCodeProcess(child.hProcess, &exitCode) || exitCode != 0) failed = 1;
finish:
  if (attributesReady) DeleteProcThreadAttributeList(start.lpAttributeList);
  if (failed && child.hProcess) {
    if (attached) (void)TerminateJobObject(job, 70);
    else (void)TerminateProcess(child.hProcess, 70);
  }
  if (child.hProcess) {
    ULONGLONG end = GetTickCount64() + 5000; DWORD remaining = 1;
    while (GetTickCount64() < end) {
      if (attached ? (jobActive(job, &remaining) && !remaining) : WaitForSingleObject(child.hProcess, 0) == WAIT_OBJECT_0) break;
      Sleep(10);
    }
    if (attached ? (!jobActive(job, &remaining) || remaining) : WaitForSingleObject(child.hProcess, 0) != WAIT_OBJECT_0) failed = 1;
  }
  /* Successful return requires every original native object to close. A
   * failed close yields no drain receipt; the isolated worker stays retained. */
  if (brc38WinDrainFileCheckResources() != SQLITE_OK) failed = 1;
  for (int i = brc38WinOwnedCount - 1; i >= 0; i--) {
    int retained = 0;
    for (int j = 0; j < brc38WinHandleCount; j++)
      if (brc38WinOwnedHandles[i] == brc38WinRetainedHandles[j]) retained = 1;
    if (!retained && !brc38WinPhysicalClose(brc38WinOwnedHandles[i])) failed = 1;
  }
  if (brc38WinOwnedCount) failed = 1;
  if (failed) return 70;
  printf("\nBRC38_WINDOWS_BUILD_DRAINED:%s:%s\n", BRC38_BUILD_POLICY_SHA256, addon ? "addon" : "driver");
  return fflush(stdout) == 0 ? 0 : 71;
}
