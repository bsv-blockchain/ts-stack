'use strict'
// Internal immutable build DATA shared by source preparation, candidate builders
// and packed artifacts. A supported recipe is never a host qualification,
// runtime pin, compiler/process admission or wallet capability grant.
const sqlite = Object.freeze({
  bytes: 9516284,
  sha256: '6a2805f8c1ef020a7086e62258519323cf98b219e9fe87a42065d916cfebaefc',
  version: '3.53.4',
  sourceId: '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc'
})
const driverSources = Object.freeze([
  'native_contract.c',
  'brc38_quota.c',
  'brc38_runtime.c',
  'profile_contract.c',
  'native_driver.c',
  'shared_quota_sources.h',
  'shared_quota_contract.c',
  'cell_change_contract.c',
  'local_observer_contract.c',
  'local_pointer_projection_contract.c',
  'local_pointer_group_contract.c',
  'local_observer_names_contract.c',
  'blob_write.c',
  'blob_read.c',
  'recovery_copy.c',
  'private_stage.c',
  'private_stage_contract.c',
  'native_fixture.c',
  'range_contract.c',
  'brc38_windows_handles.c',
  'brc38_quota_windows.c',
  'brc38_runtime_windows.c',
  'runtime_contract.c'
])
const windowsAddonSources = Object.freeze(['windows_bridge.c', 'windows_image.c', 'windows_build_supervisor.c'])
const sqliteFiles = Object.freeze([
  Object.freeze({
    name: 'sqlite3.c',
    bytes: 9516284,
    sha256: '6a2805f8c1ef020a7086e62258519323cf98b219e9fe87a42065d916cfebaefc'
  }),
  Object.freeze({
    name: 'sqlite3.h',
    bytes: 690838,
    sha256: '919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d'
  }),
  Object.freeze({
    name: 'sqlite3ext.h',
    bytes: 39175,
    sha256: 'ac9645e5c9ff0cf176efdd6e75cb5e98f46295d38e02db5c4d208826a39ab4be'
  })
])
const linuxFlags = Object.freeze([
  '-O2',
  '-pipe',
  '-std=c11',
  '-D_GNU_SOURCE',
  '-DSQLITE_THREADSAFE=1',
  '-DSQLITE_DEFAULT_MEMSTATUS=1',
  '-DSQLITE_DQS=0',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-I.',
  'native_driver.c',
  '-o',
  'native-candidate',
  '-lpthread',
  '-ldl',
  '-lm'
])

function unixCompilerArguments(platform, architecture) {
  if (!['linux', 'darwin'].includes(platform) || !['arm64', 'x64'].includes(architecture))
    throw new Error('Native candidate recipe requires a controlled supported Unix worker')
  // Darwin's loader functions are in libSystem. Select the Node worker's
  // architecture explicitly rather than relying on a compiler host default.
  return Object.freeze(
    platform === 'darwin'
      ? [
          '-arch',
          architecture === 'arm64' ? 'arm64' : 'x86_64',
          ...linuxFlags.filter(flag => flag !== '-ldl' && flag !== '-D_GNU_SOURCE')
        ]
      : [...linuxFlags]
  )
}

/** Check the target encoded in captured candidate DATA before a build receipt.
 * This is not a full loader, image signature check or runtime admission.
 * @param {Buffer} bytes @param {string} platform @param {string} architecture
 * @param {'driver'|'addon'} [kind] */
function assertNativeCandidateTarget(bytes, platform, architecture, kind = 'driver') {
  const mismatch = () => {
    throw new Error('Native candidate image differs from its build target')
  }
  if (!Buffer.isBuffer(bytes) || !['arm64', 'x64'].includes(architecture) || !['driver', 'addon'].includes(kind))
    mismatch()
  if (platform === 'linux' && kind === 'driver') {
    // ELF64 little endian: e_type, e_machine, e_version and e_ehsize.
    if (
      bytes.length < 64 ||
      bytes.readUInt32LE(0) !== 0x464c457f ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes[6] !== 1 ||
      ![2, 3].includes(bytes.readUInt16LE(16)) ||
      bytes.readUInt16LE(18) !== (architecture === 'arm64' ? 183 : 62) ||
      bytes.readUInt32LE(20) !== 1 ||
      bytes.readUInt16LE(52) !== 64
    )
      mismatch()
  } else if (platform === 'darwin' && kind === 'driver') {
    // A single selected architecture must produce a thin Mach-O executable.
    if (
      bytes.length < 32 ||
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== (architecture === 'arm64' ? 0x0100000c : 0x01000007) ||
      bytes.readUInt32LE(12) !== 2
    )
      mismatch()
  } else if (platform === 'win32') {
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) mismatch()
    const offset = bytes.readUInt32LE(60)
    if (offset < 64 || offset > bytes.length - 24) mismatch()
    const optionalBytes = bytes.readUInt16LE(offset + 20),
      characteristics = bytes.readUInt16LE(offset + 22)
    if (
      bytes.readUInt32LE(offset) !== 0x00004550 ||
      bytes.readUInt16LE(offset + 4) !== (architecture === 'arm64' ? 0xaa64 : 0x8664) ||
      optionalBytes < 112 ||
      optionalBytes > bytes.length - offset - 24 ||
      bytes.readUInt16LE(offset + 24) !== 0x20b ||
      (characteristics & 2) === 0 ||
      ((characteristics & 0x2000) !== 0) !== (kind === 'addon')
    )
      mismatch()
  } else mismatch()
}
module.exports = Object.freeze({
  sqlite,
  sqliteFiles,
  driverSources,
  windowsAddonSources,
  unixCompilerArguments,
  assertNativeCandidateTarget
})
