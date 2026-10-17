'use strict'

// Source-preparation I/O cases only. They do not run a compiler/native engine or
// convert a source manifest into admission/qualification evidence.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { prepareNativeSource, NativeSourceCleanupError } = require('./prepare_source.cjs')

let directory
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-source-data-'))
})
afterEach(async () => {
  jest.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

test.each(['arm64', 'x64'])(
  'Linux %s qualification target planning is immutable DATA with an explicit Docker target',
  architecture => {
    const { planLinuxQualificationHost } = require('../../../../tools/Brc38NativeQualification.cjs'),
      noCompiler = jest.spyOn(require('node:child_process'), 'spawn'),
      plan = planLinuxQualificationHost('linux', architecture, 'v24.18.0', '137')
    expect(plan).toEqual({
      platform: 'linux',
      architecture,
      nodeVersion: 'v24.18.0',
      nodeABI: '137',
      dockerPlatform: architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64'
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(noCompiler).not.toHaveBeenCalled()
  }
)
test.each([
  ['darwin', 'arm64', 'v24.18.0', '137'],
  ['win32', 'x64', 'v24.18.0', '137'],
  ['linux', 'ia32', 'v24.18.0', '137'],
  ['linux', 'x86_64', 'v24.18.0', '137'],
  ['linux', 'arm64', 'v24.17.0', '137'],
  ['linux', 'arm64', 'v24.18.0', '136']
])('unsupported qualification worker %s/%s/%s/%s refuses before host work', (...host) => {
  const { planLinuxQualificationHost } = require('../../../../tools/Brc38NativeQualification.cjs'),
    noCompiler = jest.spyOn(require('node:child_process'), 'spawn')
  expect(() => planLinuxQualificationHost(...host)).toThrow('admitted Linux ARM64/x64 Node24.18.0 ABI137 worker')
  expect(noCompiler).not.toHaveBeenCalled()
})
test('qualified component lookup returns the immutable original static build metadata only', async () => {
  const owner = require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs'),
    pin = owner.qualifiedNativeComponentBuild('linux', 'arm64')
  expect(pin).toBe(owner.componentBuild)
  expect(pin).toEqual({
    platform: 'linux',
    architecture: 'arm64',
    bytes: 1353552,
    sha256: '295ae7b2511b7565dd49ed352ba9e8de5cf6b924c89cb021e1d9ec5bcac929dd'
  })
  expect(Object.isFrozen(pin)).toBe(true)
  await expect(owner.pinnedNativeLaunchPath(pin)).rejects.toThrow('original pinned executable descriptor')
})
test('qualified x64 metadata is immutable, distinct from ARM64 and never a launch descriptor', async () => {
  const owner = require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs'),
    pin = owner.qualifiedNativeComponentBuild('linux', 'x64')
  expect(pin).toEqual({
    platform: 'linux',
    architecture: 'x64',
    bytes: 1381576,
    sha256: '4ae3984e9c4a89dd3628ae9ff86613f61c3813f281ac6c16dedbe98279dd4af1'
  })
  expect(pin).not.toBe(owner.componentBuild)
  expect(Object.isFrozen(pin)).toBe(true)
  expect(Reflect.set(pin, 'sha256', owner.componentBuild.sha256)).toBe(false)
  await expect(owner.pinnedNativeLaunchPath(pin)).rejects.toThrow('original pinned executable descriptor')
})
test.each([
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
  ['linux', 'arm64/../x64']
])('currently unqualified %s/%s component lookup never falls back to the ARM64 pin', (platform, architecture) => {
  const owner = require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs')
  expect(owner.qualifiedNativeComponentBuild(platform, architecture)).toBeUndefined()
})
test('actual qualifier preflight binds the original Linux Node target and static pin without host attestation', () => {
  const { inspectNativeQualificationHost } = require('../../../../tools/Brc38NativeQualification.cjs'),
    owner = require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs'),
    host = inspectNativeQualificationHost()
  expect(host.platform).toBe(process.platform)
  expect(host.architecture).toBe(process.arch)
  expect(host.nodeVersion).toBe(process.version)
  expect(host.nodeABI).toBe(process.versions.modules)
  expect(host.pin).toBe(owner.qualifiedNativeComponentBuild())
  expect(host.outerWorkerAttested).toBe(false)
  expect(host.fullSystemQualified).toBe(false)
  expect(Object.isFrozen(host)).toBe(true)
})
test.each(['missing', 'mismatched'])(
  'qualifier %s static pin refuses before destination I/O or compilation',
  async defect => {
    const owner = require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs'),
      { qualifyBrc38NativeCandidate } = require('../../../../tools/Brc38NativeQualification.cjs'),
      noFiles = jest.spyOn(fs, 'lstat'),
      noCompiler = jest.spyOn(require('node:child_process'), 'spawn')
    jest
      .spyOn(owner, 'qualifiedNativeComponentBuild')
      .mockReturnValue(defect === 'missing' ? undefined : { ...owner.componentBuild, architecture: 'not-the-worker' })
    await expect(
      qualifyBrc38NativeCandidate({ sqliteSource: '/absent/sqlite3.c', destination: '/absent/native-contract' })
    ).rejects.toThrow('component platform is not qualified')
    expect(noFiles).not.toHaveBeenCalled()
    expect(noCompiler).not.toHaveBeenCalled()
  }
)
test('host-check CLI returns the actual admitted Docker target while extra arguments remain invalid', () => {
  const cp = require('node:child_process'),
    tool = path.resolve(__dirname, '../../../../tools/Brc38NativeQualification.cjs'),
    checked = cp.spawnSync(process.execPath, [tool, '--check-host'], { timeout: 5000, maxBuffer: 65536 }),
    invalid = cp.spawnSync(process.execPath, [tool, '--check-host', '--destination'], {
      timeout: 5000,
      maxBuffer: 65536
    })
  expect(checked.status).toBe(0)
  expect(checked.signal).toBeNull()
  expect(checked.stdout.toString()).toBe(process.arch === 'arm64' ? 'linux/arm64\n' : 'linux/amd64\n')
  expect(checked.stderr.length).toBe(0)
  expect(invalid.status).toBe(1)
  expect(invalid.stdout.length).toBe(0)
  expect(invalid.stderr.toString()).toContain('Usage: --sqlite-source')
})

test.each(['arm64', 'x64'])('Darwin %s root-copy and ordinary-actor plans are immutable DATA', async architecture => {
  const root = require('../../../../tools/Brc38RootNativeInstallation.cjs'),
    qualification = require('../../../../tools/Brc38NativeQualification.cjs'),
    owner = require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs'),
    pin = { platform: 'darwin', architecture, bytes: 64, sha256: 'a'.repeat(64) },
    rootPlan = root.planDarwinInstallationHost('darwin', architecture, 'v24.18.0', '137', 0, 0),
    actorPlan = qualification.planDarwinInstalledQualificationHost('darwin', architecture, 'v24.18.0', '137', 501, 501)
  expect(Object.isFrozen(rootPlan)).toBe(true)
  expect(Object.isFrozen(actorPlan)).toBe(true)
  expect(actorPlan.launchMechanism).toBe('protected-darwin-installed-path')
  expect(root.darwinNativeInstallationPath(pin)).toBe(
    `/Library/Application Support/BSV Wallet/native/${architecture}/${pin.sha256}/native-contract`
  )
  await expect(owner.pinnedNativeLaunchPath(pin)).rejects.toThrow('original pinned executable descriptor')
})
test.each([
  ['linux', 'arm64', 'v24.18.0', '137', 0, 0],
  ['win32', 'x64', 'v24.18.0', '137', 0, 0],
  ['darwin', 'ia32', 'v24.18.0', '137', 0, 0],
  ['darwin', 'arm64', 'v24.17.0', '137', 0, 0],
  ['darwin', 'arm64', 'v24.18.0', '136', 0, 0],
  ['darwin', 'arm64', 'v24.18.0', '137', 501, 0],
  ['darwin', 'arm64', 'v24.18.0', '137', 0, 501]
])('unsupported root-install plan %s/%s/%s/%s/%s/%s refuses', (...host) => {
  expect(() =>
    require('../../../../tools/Brc38RootNativeInstallation.cjs').planDarwinInstallationHost(...host)
  ).toThrow()
})
test.each([
  ['linux', 'arm64', 'v24.18.0', '137', 501, 501],
  ['darwin', 'arm64', 'v24.18.0', '137', 0, 0],
  ['darwin', 'x64', 'v24.18.0', '137', 501, 0],
  ['darwin', 'arm64', 'v24.18.0', '137', -1, -1],
  ['darwin', 'arm64', 'v24.18.0', '137', 1.5, 1.5]
])('unsupported installed-actor plan %s/%s/%s/%s/%s/%s refuses', (...host) => {
  expect(() =>
    require('../../../../tools/Brc38NativeQualification.cjs').planDarwinInstalledQualificationHost(...host)
  ).toThrow()
})
test('actual Linux host refuses both Darwin routes before filesystem or compiler work', async () => {
  const root = require('../../../../tools/Brc38RootNativeInstallation.cjs'),
    qualification = require('../../../../tools/Brc38NativeQualification.cjs'),
    files = jest.spyOn(fs, 'open'),
    stat = jest.spyOn(fs, 'lstat'),
    compiler = jest.spyOn(require('node:child_process'), 'spawn')
  await expect(root.installDarwinNativeCandidate({ source: '/absent/native-candidate' })).rejects.toThrow('actual root')
  await expect(
    qualification.qualifyInstalledDarwinCandidate({ sqliteSource: '/absent/sqlite3.c', outputParent: '/absent/output' })
  ).rejects.toThrow('ordinary non-root wallet actor')
  expect(files).not.toHaveBeenCalled()
  expect(stat).not.toHaveBeenCalled()
  expect(compiler).not.toHaveBeenCalled()
})
test.each(
  [
    [],
    ['--source', 'relative'],
    ['--source', '/tmp/../native-candidate'],
    ['--source', '/tmp/native\0candidate'],
    ['--source', '/private/native', '--destination', '/Library/changed']
  ].map(args => [args])
)('root-copy CLI refuses ambiguous paths or installation overrides %p', args => {
  expect(() =>
    require('../../../../tools/Brc38RootNativeInstallation.cjs').parseDarwinInstallationArguments(args)
  ).toThrow()
})

test('a missing pinned dependency removes only its owned source directory and preserves neighboring input', async () => {
  const neighbor = path.join(directory, 'neighbor')
  await fs.writeFile(neighbor, 'preserved', { flag: 'wx' })
  await expect(prepareNativeSource(path.join(directory, 'missing-input'), directory)).rejects.toThrow()
  expect(await fs.readdir(directory)).toEqual(['neighbor'])
  expect(await fs.readFile(neighbor, 'utf8')).toBe('preserved')
})
test('a symlink dependency is refused before reading its target and no incomplete source manifest remains', async () => {
  const input = path.join(directory, 'sqlite-input')
  await fs.mkdir(input)
  const unrelated = path.join(directory, 'unrelated')
  await fs.writeFile(unrelated, 'preserved', { flag: 'wx' })
  await fs.symlink(unrelated, path.join(input, 'sqlite3.c'))
  await expect(prepareNativeSource(input, directory)).rejects.toThrow()
  expect((await fs.readdir(directory)).sort()).toEqual(['sqlite-input', 'unrelated'])
  expect(await fs.readFile(unrelated, 'utf8')).toBe('preserved')
})

test('a descriptor close failure retains its owned source directory until concrete retry finishes disposal', async () => {
  const originalOpen = fs.open,
    reason = new Error('synthetic descriptor-close refusal')
  let injected = false
  const opened = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    if (!injected && String(args[0]).endsWith('native_driver.c') && args[1] === 'wx') {
      injected = true
      const originalClose = handle.close.bind(handle)
      let first = true
      handle.close = async () => {
        if (first) {
          first = false
          throw reason
        }
        await originalClose()
      }
    }
    return handle
  })
  const failure = await prepareNativeSource(path.join(directory, 'missing-input'), directory).then(
    () => undefined,
    error => error
  )
  expect(failure).toBeInstanceOf(NativeSourceCleanupError)
  const retained = await fs.readdir(directory)
  expect(retained).toHaveLength(1)
  expect(retained[0]).toMatch(/^wallet-native-source-/)
  opened.mockRestore()
  await failure.retryCleanup()
  expect(await fs.readdir(directory)).toEqual([])
  await failure.retryCleanup()
})

// Pure recipe/source capture on the current controlled worker. These targets
// select build DATA only; no compiler, native engine or other OS is executed.
test.each([
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['darwin', 'arm64'],
  ['darwin', 'x64']
])(
  'complete %s/%s source plan includes every transitive driver file and exact pinned SQLite inputs',
  async (platform, architecture) => {
    const crypto = require('node:crypto'),
      sqliteDirectory = path.join(path.dirname(require.resolve('better-sqlite3/package.json')), 'deps/sqlite3'),
      { driverSources, windowsAddonSources, sqliteFiles, unixCompilerArguments } = require('./source_recipe.cjs'),
      prepared = await prepareNativeSource(sqliteDirectory, directory, { platform, architecture }),
      source = JSON.parse(await fs.readFile(path.join(prepared.directory, 'source.json'), 'utf8')),
      expected = [...driverSources, ...windowsAddonSources, ...sqliteFiles.map(input => input.name)]
    expect(source).toEqual(prepared.source)
    expect(source.inputs.map(input => input.name)).toEqual(expected)
    // The driver entry is independently required; matching shared lists alone
    // must not conceal a missing entry point. Its actual transitive includes
    // are checked below. SQLite amalgamation and Windows bootstrap policy have
    // separate dependency/generated-input contracts.
    expect(expected).toContain('native_driver.c')
    expect(new Set(expected).size).toBe(expected.length)
    expect(source.platform).toBe(platform)
    expect(source.architecture).toBe(architecture)
    expect(source.compiler.cwd).toBe(prepared.directory)
    expect(source.compiler.arguments).toEqual(unixCompilerArguments(platform, architecture))
    expect(source.compiled).toBe(false)
    expect(source.engineExecuted).toBe(false)
    expect(source.qualified).toBe(false)
    for (const input of source.inputs) {
      const actual = await fs.readFile(path.join(prepared.directory, input.name))
      expect(actual.length).toBe(input.bytes)
      expect(crypto.createHash('sha256').update(actual).digest('hex')).toBe(input.sha256)
      if (driverSources.includes(input.name) && input.name.endsWith('.c')) {
        for (const included of actual.toString('utf8').matchAll(/^#include "([^"/]+)"/gm))
          expect(expected).toContain(included[1])
      }
    }
    for (const dependency of sqliteFiles)
      expect(source.inputs.find(input => input.name === dependency.name)).toEqual(dependency)
    expect(crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex')).toBe(prepared.manifestSha256)
    if (platform === 'darwin') {
      expect(source.compiler.arguments.slice(0, 2)).toEqual(['-arch', architecture === 'arm64' ? 'arm64' : 'x86_64'])
      expect(source.compiler.arguments).not.toContain('-ldl')
      expect(source.compiler.arguments).not.toContain('-D_GNU_SOURCE')
    } else {
      expect(source.compiler.arguments).toContain('-ldl')
      expect(source.compiler.arguments).toContain('-D_GNU_SOURCE')
    }
  }
)
test.each([
  ['win32', 'x64'],
  ['linux', 'ia32'],
  ['darwin', 'unknown'],
  ['unknown', 'arm64']
])(
  'unsupported %s/%s preparation refuses before reading input or creating source assets',
  async (platform, architecture) => {
    await expect(
      prepareNativeSource(path.join(directory, 'absent'), directory, { platform, architecture })
    ).rejects.toThrow('controlled supported Unix worker')
    expect(await fs.readdir(directory)).toEqual([])
  }
)

// Synthetic format headers are DATA only, never executable host proof.
function targetHeader(platform, architecture, kind = 'driver') {
  const bytes = Buffer.alloc(platform === 'win32' ? 200 : platform === 'linux' ? 64 : 32)
  if (platform === 'linux') {
    Buffer.from('7f454c4602010100', 'hex').copy(bytes)
    bytes.writeUInt16LE(3, 16)
    bytes.writeUInt16LE(architecture === 'arm64' ? 183 : 62, 18)
    bytes.writeUInt32LE(1, 20)
    bytes.writeUInt16LE(64, 52)
  } else if (platform === 'darwin') {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4)
    bytes.writeUInt32LE(2, 12)
  } else {
    bytes.writeUInt16LE(0x5a4d, 0)
    bytes.writeUInt32LE(64, 60)
    bytes.writeUInt32LE(0x4550, 64)
    bytes.writeUInt16LE(architecture === 'arm64' ? 0xaa64 : 0x8664, 68)
    bytes.writeUInt16LE(112, 84)
    bytes.writeUInt16LE(kind === 'addon' ? 0x2002 : 2, 86)
    bytes.writeUInt16LE(0x20b, 88)
  }
  return bytes
}
test.each([
  ['linux', 'arm64', 'driver'],
  ['linux', 'x64', 'driver'],
  ['darwin', 'arm64', 'driver'],
  ['darwin', 'x64', 'driver'],
  ['win32', 'arm64', 'driver'],
  ['win32', 'x64', 'driver'],
  ['win32', 'arm64', 'addon'],
  ['win32', 'x64', 'addon']
])(
  'captured %s/%s/%s header matches only its actual target and complete format header',
  (platform, architecture, kind) => {
    const { assertNativeCandidateTarget: check } = require('./source_recipe.cjs'),
      bytes = targetHeader(platform, architecture, kind)
    expect(() => check(bytes, platform, architecture, kind)).not.toThrow()
    expect(() => check(bytes, platform, architecture === 'arm64' ? 'x64' : 'arm64', kind)).toThrow(
      'image differs from its build target'
    )
    for (const length of [0, 3, 31, bytes.length - 1])
      expect(() => check(bytes.subarray(0, length), platform, architecture, kind)).toThrow(
        'image differs from its build target'
      )
    if (platform === 'win32')
      expect(() => check(bytes, platform, architecture, kind === 'addon' ? 'driver' : 'addon')).toThrow(
        'image differs from its build target'
      )
  }
)
test.each([
  ['linux', 0, 'u32', 0],
  ['linux', 4, 'u8', 1],
  ['linux', 5, 'u8', 2],
  ['linux', 6, 'u8', 0],
  ['linux', 16, 'u16', 1],
  ['linux', 20, 'u32', 0],
  ['linux', 52, 'u16', 63],
  ['darwin', 0, 'u32', 0xcafebabe],
  ['darwin', 12, 'u32', 1],
  ['win32', 0, 'u16', 0],
  ['win32', 60, 'u32', 0],
  ['win32', 60, 'u32', 0xffffffff],
  ['win32', 64, 'u32', 0],
  ['win32', 84, 'u16', 0],
  ['win32', 84, 'u16', 0xffff],
  ['win32', 86, 'u16', 0],
  ['win32', 88, 'u16', 0x10b]
])('captured %s malformed target field at %i refuses a successful build receipt', (platform, offset, width, value) => {
  const { assertNativeCandidateTarget: check } = require('./source_recipe.cjs'),
    bytes = targetHeader(platform, 'arm64')
  if (width === 'u8') bytes.writeUInt8(value, offset)
  else if (width === 'u16') bytes.writeUInt16LE(value, offset)
  else bytes.writeUInt32LE(value, offset)
  expect(() => check(bytes, platform, 'arm64')).toThrow('image differs from its build target')
})
test('target checks preserve fixed ELF executable type and refuse unsupported selectors without running bytes', () => {
  const { assertNativeCandidateTarget: check } = require('./source_recipe.cjs'),
    bytes = targetHeader('linux', 'arm64')
  bytes.writeUInt16LE(2, 16)
  expect(() => check(bytes, 'linux', 'arm64')).not.toThrow()
  for (const [platform, architecture, kind] of [
    ['linux', 'ia32', 'driver'],
    ['linux', 'arm64', 'addon'],
    ['darwin', 'arm64', 'addon'],
    ['unknown', 'arm64', 'driver'],
    ['win32', 'arm64', 'unknown']
  ])
    expect(() => check(bytes, platform, architecture, kind)).toThrow('image differs from its build target')
  expect(() => check({}, 'linux', 'arm64')).toThrow('image differs from its build target')
})

// Bootstrap capture tests use synthetic Node header/import-library DATA, and
// actual authored C/SQLite bytes. They never compile or qualify Windows.
async function windowsBootstrapFixture() {
  const crypto = require('node:crypto'),
    input = path.join(directory, 'bootstrap-inputs')
  await fs.mkdir(input)
  const names = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h', 'node_version.h'],
    headers = []
  for (const name of names) {
    const bytes = Buffer.from(
      name === 'node_version.h'
        ? '#define NODE_MAJOR_VERSION 24\n#define NODE_MINOR_VERSION 18\n#define NODE_PATCH_VERSION 0\n#define NODE_MODULE_VERSION 137\n'
        : '/* synthetic header DATA; not a compilable Node dependency */\n'
    )
    await fs.writeFile(path.join(input, name), bytes, { flag: 'wx' })
    headers.push({ path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  }
  const library = Buffer.from('synthetic import-library DATA; never linked')
  await fs.writeFile(path.join(input, 'node.lib'), library, { flag: 'wx' })
  return {
    architecture: 'arm64',
    outputDirectory: directory,
    nodeHeaderDirectory: input,
    nodeHeaders: headers,
    sqliteSource: path.join(path.dirname(require.resolve('better-sqlite3/package.json')), 'deps/sqlite3/sqlite3.c'),
    nodeImportLibrary: {
      filename: path.join(input, 'node.lib'),
      bytes: library.length,
      sha256: crypto.createHash('sha256').update(library).digest('hex')
    },
    toolchain: {
      compiler: 'C:\\BuildTools\\cl.exe',
      include: 'C:\\BuildTools\\include;C:\\SDK\\include',
      lib: 'C:\\BuildTools\\lib;C:\\SDK\\lib',
      path: 'C:\\BuildTools\\bin;C:\\Windows\\System32'
    }
  }
}
test.each(['arm64', 'x64'])(
  'first-artifact %s bootstrap captures the full real source cohort and exact dependency DATA without a pre-existing addon',
  async architecture => {
    const cp = require('node:child_process'),
      noExecution = jest.spyOn(cp, 'spawn'),
      { prepareWindowsBootstrapSource } = require('../../../../tools/Brc38WindowsBootstrapBuild.cjs'),
      recipe = require('./source_recipe.cjs'),
      options = await windowsBootstrapFixture()
    options.architecture = architecture
    const prepared = await prepareWindowsBootstrapSource(options),
      source = prepared.source,
      expected = [
        ...recipe.driverSources,
        ...recipe.windowsAddonSources,
        'sqlite3.c',
        ...options.nodeHeaders.map(input => 'node-headers/' + input.path),
        'node.lib',
        'brc38_build_policy.h'
      ]
    expect(source.inputs.map(input => input.path)).toEqual(expected)
    expect(expected).toContain('native_driver.c')
    expect(expected).toContain('windows_build_supervisor.c')
    expect(source.architecture).toBe(architecture)
    expect(source.nodeVersion).toBe('24.18.0')
    expect(source.nodeModules).toBe('137')
    expect(source.compiled).toBe(false)
    expect(source.engineOrAddonExecuted).toBe(false)
    expect(source.qualified).toBe(false)
    expect(source.runtimePinChanged).toBe(false)
    expect(source.supervisorArguments).toContain('windows_build_supervisor.c')
    expect(source.addonArguments).toContain('windows_bridge.c')
    expect(source.addonArguments).toContain('/DNAPI_VERSION=8')
    const crypto = require('node:crypto')
    for (const input of source.inputs) {
      const bytes = await fs.readFile(path.join(prepared.directory, input.path))
      expect(bytes.length).toBe(input.bytes)
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(input.sha256)
    }
    expect(await fs.readFile(path.join(prepared.directory, 'brc38_build_policy.h'), 'utf8')).toContain(
      source.policySha256
    )
    expect(JSON.parse(await fs.readFile(path.join(prepared.directory, 'bootstrap-source.json'), 'utf8'))).toEqual(
      source
    )
    expect(noExecution).not.toHaveBeenCalled()
  }
)
test.each([
  'duplicate-case',
  'reserved-name',
  'traversal',
  'missing-required',
  'oversize',
  'bad-hash',
  'unknown-arch',
  'bad-library'
])('invalid first-artifact dependency %s refuses before capture or execution', async defect => {
  const { prepareWindowsBootstrapSource } = require('../../../../tools/Brc38WindowsBootstrapBuild.cjs'),
    options = await windowsBootstrapFixture(),
    before = await fs.readdir(directory),
    noExecution = jest.spyOn(require('node:child_process'), 'spawn')
  if (defect === 'duplicate-case') options.nodeHeaders.push({ ...options.nodeHeaders[0], path: 'NODE_API.h' })
  else if (defect === 'reserved-name') options.nodeHeaders.push({ ...options.nodeHeaders[0], path: 'NUL.h' })
  else if (defect === 'traversal') options.nodeHeaders[0].path = '../node_api.h'
  else if (defect === 'missing-required') options.nodeHeaders[0].path = 'other.h'
  else if (defect === 'oversize') options.nodeHeaders[0].bytes = 2097153
  else if (defect === 'bad-hash') options.nodeHeaders[0].sha256 = '00'
  else if (defect === 'unknown-arch') options.architecture = 'ia32'
  else options.nodeImportLibrary.bytes = 33554433
  await expect(prepareWindowsBootstrapSource(options)).rejects.toThrow('Windows bootstrap')
  expect(await fs.readdir(directory)).toEqual(before)
  expect(noExecution).not.toHaveBeenCalled()
})
test('wrong captured Node ABI refuses the source plan and removes only its uncompiled owned root', async () => {
  const { prepareWindowsBootstrapSource } = require('../../../../tools/Brc38WindowsBootstrapBuild.cjs'),
    options = await windowsBootstrapFixture(),
    crypto = require('node:crypto'),
    filename = path.join(options.nodeHeaderDirectory, 'node_version.h'),
    bytes = Buffer.from((await fs.readFile(filename, 'utf8')).replace('VERSION 137', 'VERSION 136'))
  await fs.writeFile(filename, bytes)
  Object.assign(
    options.nodeHeaders.find(input => input.path === 'node_version.h'),
    { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  )
  await expect(prepareWindowsBootstrapSource(options)).rejects.toThrow('captured Node version or ABI differs')
  expect(await fs.readdir(directory)).toEqual(['bootstrap-inputs'])
  expect(await fs.readFile(filename)).toEqual(bytes)
})
test('an unsupported worker target cannot compile first artifacts or run a private-directory helper', async () => {
  const { buildWindowsBootstrap } = require('../../../../tools/Brc38WindowsBootstrapBuild.cjs'),
    noExecution = jest.spyOn(require('node:child_process'), 'spawn')
  await expect(buildWindowsBootstrap({ architecture: 'ia32' })).rejects.toThrow(
    'original isolated Windows Node24.18.0 ABI137 worker'
  )
  expect(noExecution).not.toHaveBeenCalled()
  expect(await fs.readdir(directory)).toEqual([])
})

test('bootstrap manifest write and close failures retain both errors and the actual descriptor until retry', async () => {
  const { prepareWindowsBootstrapSource } = require('../../../../tools/Brc38WindowsBootstrapBuild.cjs'),
    options = await windowsBootstrapFixture(),
    originalOpen = fs.open,
    writeFailure = new Error('synthetic bootstrap manifest write failure'),
    closeFailure = new Error('synthetic bootstrap manifest close failure')
  let retained
  const opening = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await originalOpen(...args)
    if (String(args[0]).endsWith('bootstrap-source.json') && args[1] === 'wx') {
      retained = file
      const originalClose = file.close.bind(file)
      let first = true
      file.writeFile = async () => {
        throw writeFailure
      }
      file.close = async () => {
        if (first) {
          first = false
          throw closeFailure
        }
        await originalClose()
      }
    }
    return file
  })
  const failure = await prepareWindowsBootstrapSource(options).then(
    () => undefined,
    error => error
  )
  expect(failure).toBeInstanceOf(NativeSourceCleanupError)
  expect(failure.errors[0]).toBeInstanceOf(NativeSourceCleanupError)
  expect(failure.errors[0].errors).toEqual([writeFailure, closeFailure])
  expect(retained.fd).toBeGreaterThanOrEqual(0)
  expect((await fs.readdir(directory)).filter(name => name.startsWith('brc38-windows-bootstrap-'))).toHaveLength(1)
  opening.mockRestore()
  await failure.retryCleanup()
  expect(retained.fd).toBe(-1)
  expect(await fs.readdir(directory)).toEqual(['bootstrap-inputs'])
  await failure.retryCleanup()
})

// Hyper-V work orders remain comparison DATA, not permission to operate a host.
function windowsHostFixture() {
  return {
    protocol: 'brc38-windows-bootstrap-host-work-order/v1',
    runId: '12345678-1234-1234-1234-123456789abc',
    vmId: 'abcdef12-1234-1234-1234-123456789abc',
    architecture: 'x64',
    guestActorSid: 'S-1-5-21-111-222-333-1001',
    hostController: { bytes: 123, sha256: '1'.repeat(64) },
    guestController: {
      filename: 'C:\\Source\\tools\\Brc38WindowsBootstrapController.ps1',
      bytes: 456,
      sha256: '2'.repeat(64)
    },
    guestConfiguration: { filename: 'C:\\Private\\worker-options.json', bytes: 789, sha256: '3'.repeat(64) }
  }
}
test.each(['arm64', 'x64'])(
  'Hyper-V %s work order preserves exact run/VM/source DATA without claiming a real supported host',
  async architecture => {
    const input = windowsHostFixture(),
      host = require('../../../../tools/Brc38WindowsBootstrapHost.cjs'),
      execution = jest.spyOn(require('node:child_process'), 'spawn')
    input.architecture = architecture
    const plan = host.bootstrapHostPlan(input)
    input.guestController.sha256 = '4'.repeat(64)
    input.vmId = 'bad'
    expect(plan.architecture).toBe(architecture)
    expect(plan.vmName).toBe('ts569-native-windows-bootstrap-' + plan.runId)
    expect(plan.guestController.sha256).toBe('2'.repeat(64))
    expect(Object.isFrozen(plan.guestController)).toBe(true)
    expect(Object.isFrozen(plan.limits)).toBe(true)
    expect(plan.hostAdmitted).toBe(false)
    expect(plan.qualified).toBe(false)
    expect(plan.runtimePinChanged).toBe(false)
    expect(execution).not.toHaveBeenCalled()
    await expect(
      require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs').pinnedNativeLaunchPath(plan)
    ).rejects.toThrow('original pinned executable descriptor')
  }
)
test.each([
  'protocol',
  'run',
  'zero-run',
  'VM',
  'zero-VM',
  'architecture',
  'SID',
  'SID-overflow',
  'source-digest',
  'source-size',
  'guest-size',
  'controller',
  'same-input',
  'UNC',
  'traversal',
  'stream',
  'reserved',
  'control',
  'limits-override'
])('Hyper-V %s work-order refuses before any host operation', defect => {
  const input = windowsHostFixture(),
    execution = jest.spyOn(require('node:child_process'), 'spawn')
  if (defect === 'protocol') input.protocol = 'other'
  else if (defect === 'run') input.runId = 'unverified'
  else if (defect === 'zero-run') input.runId = '00000000-0000-0000-0000-000000000000'
  else if (defect === 'VM') input.vmId = 'not-a-guid'
  else if (defect === 'zero-VM') input.vmId = '00000000-0000-0000-0000-000000000000'
  else if (defect === 'architecture') input.architecture = 'ia32'
  else if (defect === 'SID') input.guestActorSid = 'S-1-5-18'
  else if (defect === 'SID-overflow') input.guestActorSid = 'S-1-5-21-4294967296-222-333-1001'
  else if (defect === 'source-digest') input.hostController.sha256 = 'bad'
  else if (defect === 'source-size') input.hostController.bytes = 1048577
  else if (defect === 'guest-size') input.guestConfiguration.bytes = 1.5
  else if (defect === 'controller') input.guestController.filename = 'C:\\Source\\tools\\Other.ps1'
  else if (defect === 'same-input') input.guestConfiguration.filename = input.guestController.filename
  else if (defect === 'UNC') input.guestConfiguration.filename = '\\\\server\\private\\options.json'
  else if (defect === 'traversal') input.guestConfiguration.filename = 'C:\\Private\\..\\options.json'
  else if (defect === 'stream') input.guestConfiguration.filename += ':alternate'
  else if (defect === 'reserved') input.guestConfiguration.filename = 'C:\\Private\\NUL'
  else if (defect === 'control') input.guestConfiguration.filename += String.fromCharCode(0)
  else input.limits = { memoryBytes: 1 }
  expect(() => require('../../../../tools/Brc38WindowsBootstrapHost.cjs').bootstrapHostPlan(input)).toThrow(
    'Windows host'
  )
  expect(execution).not.toHaveBeenCalled()
})
test('actual bounded Hyper-V work-order capture closes its descriptor and preserves independent source DATA', async () => {
  const input = windowsHostFixture(),
    filename = path.join(directory, 'host-options.json')
  await fs.writeFile(filename, JSON.stringify(input), { flag: 'wx' })
  const plan = await require('../../../../tools/Brc38WindowsBootstrapHost.cjs').readBootstrapHostConfiguration(filename)
  expect(plan.guestConfiguration.sha256).toBe(input.guestConfiguration.sha256)
  expect(plan.hostAdmitted).toBe(false)
  expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual(input)
})
test.each(['symlink', 'hard-link', 'too-large', 'UTF8'])(
  'actual Hyper-V %s work-order refuses with real local files and no host execution',
  async defect => {
    const input = path.join(directory, 'host-input.json'),
      execution = jest.spyOn(require('node:child_process'), 'spawn')
    if (defect === 'symlink') await fs.symlink(path.join(directory, 'absent'), input)
    else {
      const bytes =
        defect === 'too-large'
          ? Buffer.alloc(1048577)
          : defect === 'UTF8'
            ? Buffer.from([0xff])
            : Buffer.from(JSON.stringify(windowsHostFixture()))
      await fs.writeFile(input, bytes, { flag: 'wx' })
      if (defect === 'hard-link') await fs.link(input, path.join(directory, 'second-input.json'))
    }
    await expect(
      require('../../../../tools/Brc38WindowsBootstrapHost.cjs').readBootstrapHostConfiguration(input)
    ).rejects.toThrow()
    expect(execution).not.toHaveBeenCalled()
  }
)
test('failed actual Hyper-V input read/close retains both causes and retries its same original descriptor', async () => {
  const input = path.join(directory, 'host-input.json'),
    originalOpen = fs.open,
    readFailure = new Error('synthetic bounded input read failure'),
    closeFailure = new Error('synthetic original close failure')
  await fs.writeFile(input, JSON.stringify(windowsHostFixture()), { flag: 'wx' })
  let retained,
    attempts = 0
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await originalOpen(...args)
    if (args[0] === input) {
      retained = file
      file.read = async () => {
        throw readFailure
      }
      const close = file.close.bind(file)
      file.close = async () => {
        if (++attempts === 1) throw closeFailure
        await close()
      }
    }
    return file
  })
  const failure = await require('../../../../tools/Brc38WindowsBootstrapHost.cjs')
    .readBootstrapHostConfiguration(input)
    .catch(e => e)
  expect(failure).toBeInstanceOf(NativeSourceCleanupError)
  expect(failure.errors).toEqual([readFailure, closeFailure])
  expect(retained.fd).toBeGreaterThanOrEqual(0)
  await failure.retryCleanup()
  await failure.retryCleanup()
  expect(retained.fd).toBe(-1)
  expect(attempts).toBe(2)
})

// Outer-worker source/data regressions. No synthetic observation is real Job
// evidence, and these controls never invoke PowerShell, .NET or a compiler.
async function windowsBootstrapWorkerFixture() {
  const { controllerInputs } = require('../../../../tools/Brc38WindowsBootstrapWorker.cjs'),
    crypto = require('node:crypto'),
    bootstrap = await windowsBootstrapFixture(),
    inputs = []
  for (const name of controllerInputs) {
    const bytes = await fs.readFile(path.join(__dirname, '../../../../', name))
    inputs.push({ path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  }
  Object.assign(bootstrap, {
    outputDirectory: 'C:\\Private\\original-root',
    sqliteSource: 'C:\\Inputs\\sqlite3.c',
    nodeHeaderDirectory: 'C:\\Inputs\\node-headers'
  })
  bootstrap.nodeImportLibrary.filename = 'C:\\Inputs\\node.lib'
  return {
    architecture: bootstrap.architecture,
    bootstrap,
    controllerInputs: inputs,
    nodeExecutable: { filename: 'C:\\Node\\node.exe', bytes: 123, sha256: '1'.repeat(64) }
  }
}
test.each(['arm64', 'x64'])(
  'outer %s worker plan snapshots the real authored controller cohort without executing it',
  async architecture => {
    const { bootstrapWorkerPlan } = require('../../../../tools/Brc38WindowsBootstrapWorker.cjs'),
      configuration = await windowsBootstrapWorkerFixture(),
      noExecution = jest.spyOn(require('node:child_process'), 'spawn')
    configuration.architecture = configuration.bootstrap.architecture = architecture
    const plan = bootstrapWorkerPlan(configuration),
      header = plan.bootstrap.nodeHeaders[0].sha256,
      source = plan.controllerInputs[0].sha256
    configuration.bootstrap.nodeHeaders[0].sha256 = '2'.repeat(64)
    configuration.controllerInputs[0].sha256 = '3'.repeat(64)
    configuration.bootstrap.toolchain.compiler = 'C:\\Other\\cl.exe'
    expect(plan.architecture).toBe(architecture)
    expect(plan.bootstrap.nodeHeaders[0].sha256).toBe(header)
    expect(plan.controllerInputs[0].sha256).toBe(source)
    expect(plan.bootstrap.toolchain.compiler).toBe('C:\\BuildTools\\cl.exe')
    expect(plan.limits).toEqual({
      memoryBytes: 12884901888,
      processCount: 512,
      maximumCPUCount: 4,
      nodeHeapMiB: 1536,
      deadlineMilliseconds: 600000,
      drainMilliseconds: 10000
    })
    expect(plan.compiled).toBe(false)
    expect(plan.qualified).toBe(false)
    expect(plan.runtimePinChanged).toBe(false)
    expect(Object.isFrozen(plan.bootstrap.nodeHeaders[0])).toBe(true)
    expect(Object.isFrozen(plan.controllerInputs[0])).toBe(true)
    expect(noExecution).not.toHaveBeenCalled()
  }
)
test.each([
  'mismatched-arch',
  'missing-controller',
  'reordered-controller',
  'source-digest',
  'source-extent',
  'node-name',
  'node-digest',
  'node-extent',
  'UNC',
  'traversal',
  'reserved',
  'alias',
  'stream',
  'control-nul',
  'control-unit'
])('outer worker %s refuses before any host operation', async defect => {
  const { bootstrapWorkerPlan } = require('../../../../tools/Brc38WindowsBootstrapWorker.cjs'),
    config = await windowsBootstrapWorkerFixture(),
    noExecution = jest.spyOn(require('node:child_process'), 'spawn')
  if (defect === 'mismatched-arch') config.architecture = 'x64'
  else if (defect === 'missing-controller') config.controllerInputs.pop()
  else if (defect === 'reordered-controller') config.controllerInputs.reverse()
  else if (defect === 'source-digest') config.controllerInputs[0].sha256 = 'bad'
  else if (defect === 'source-extent') config.controllerInputs[0].bytes = 1048577
  else if (defect === 'node-name') config.nodeExecutable.filename = 'C:\\Node\\other.exe'
  else if (defect === 'node-digest') config.nodeExecutable.sha256 = 'bad'
  else if (defect === 'node-extent') config.nodeExecutable.bytes = 134217729
  else if (defect === 'UNC') config.bootstrap.outputDirectory = '\\\\server\\private'
  else if (defect === 'traversal') config.bootstrap.outputDirectory = 'C:\\Private\\..\\other'
  else if (defect === 'reserved') config.bootstrap.outputDirectory = 'C:\\Private\\NUL'
  else if (defect === 'alias') config.bootstrap.outputDirectory = 'C:\\Private\\root. '
  else if (defect === 'stream') config.bootstrap.outputDirectory = 'C:\\Private\\root:alternate'
  else if (defect === 'control-nul') config.bootstrap.outputDirectory += String.fromCharCode(0)
  else if (defect === 'control-unit') config.bootstrap.outputDirectory += String.fromCharCode(31)
  expect(() => bootstrapWorkerPlan(config)).toThrow('Windows bootstrap')
  expect(noExecution).not.toHaveBeenCalled()
})
function syntheticBootstrapControllerData() {
  return {
    protocol: 'brc38-windows-bootstrap-controller/v1',
    controllerFilesClosed: true,
    controllerErrors: [],
    VMShutdownObserved: false,
    qualified: false,
    runtimePinChanged: false,
    engineOrAddonExecuted: false,
    worker: {
      protocol: 'brc38-windows-bootstrap-worker/v1',
      success: true,
      qualified: false,
      runtimePinChanged: false
    },
    job: {
      Success: true,
      AssignedBeforeResume: true,
      LimitsReadBack: true,
      NonInheritedJobHandle: true,
      WorkerExitObserved: true,
      ZeroActiveProcessesObserved: true,
      AllHandlesClosed: true,
      OriginalProcessWorkerStopped: true,
      DeadlineExpired: false,
      WorkerExitCode: 0,
      MemoryLimitBytes: 12884901888,
      ProcessLimit: 512,
      MaximumCPUCount: 4,
      AffinityMaskHex: '000000000000000f',
      DeadlineMilliseconds: 600000,
      Errors: [],
      Qualified: false,
      VMShutdownObserved: false
    },
    candidates: [
      { path: 'brc38-build-supervisor.exe', bytes: 512, sha256: '1'.repeat(64) },
      { path: 'brc38_windows.node', bytes: 512, sha256: '2'.repeat(64) }
    ]
  }
}
test('complete synthetic controller observations remain explicitly unqualified DATA, not a host enrollment', () => {
  const { inspectBootstrapWorkerResult } = require('../../../../tools/Brc38WindowsBootstrapWorker.cjs'),
    input = syntheticBootstrapControllerData(),
    data = inspectBootstrapWorkerResult(input)
  expect(data.qualified).toBe(false)
  expect(data.runtimePinChanged).toBe(false)
  expect(data.VMShutdownObserved).toBe(false)
  expect(Object.isFrozen(data.candidates[0])).toBe(true)
  input.candidates[0].sha256 = '3'.repeat(64)
  expect(data.candidates[0].sha256).toBe('1'.repeat(64))
})
test.each([
  'Success',
  'AssignedBeforeResume',
  'LimitsReadBack',
  'NonInheritedJobHandle',
  'WorkerExitObserved',
  'ZeroActiveProcessesObserved',
  'AllHandlesClosed',
  'OriginalProcessWorkerStopped'
])('a missing actual %s observation cannot pass exported build DATA validation', field => {
  const { inspectBootstrapWorkerResult } = require('../../../../tools/Brc38WindowsBootstrapWorker.cjs'),
    data = syntheticBootstrapControllerData()
  delete data.job[field]
  expect(() => inspectBootstrapWorkerResult(data)).toThrow('incomplete or failed')
})
test.each([
  'timeout',
  'failed-exit',
  'job-close-error',
  'file-close-error',
  'qualified',
  'VM-stop',
  'wrong-memory',
  'wrong-PIDs',
  'wrong-affinity',
  'missing-affinity',
  'wrong-candidate',
  'candidate-digest',
  'worker-failed'
])('controller %s cannot be laundered into successful exported DATA', defect => {
  const { inspectBootstrapWorkerResult } = require('../../../../tools/Brc38WindowsBootstrapWorker.cjs'),
    data = syntheticBootstrapControllerData()
  if (defect === 'timeout') data.job.DeadlineExpired = true
  else if (defect === 'failed-exit') data.job.WorkerExitCode = 1
  else if (defect === 'job-close-error') data.job.Errors = ['original handle still retained']
  else if (defect === 'file-close-error') data.controllerFilesClosed = false
  else if (defect === 'qualified') data.qualified = true
  else if (defect === 'VM-stop') data.job.VMShutdownObserved = true
  else if (defect === 'wrong-memory') data.job.MemoryLimitBytes++
  else if (defect === 'wrong-PIDs') data.job.ProcessLimit++
  else if (defect === 'wrong-affinity') data.job.AffinityMaskHex = '00000000000000ff'
  else if (defect === 'missing-affinity') delete data.job.AffinityMaskHex
  else if (defect === 'wrong-candidate') data.candidates[1].path = '../other.node'
  else if (defect === 'candidate-digest') data.candidates[1].sha256 = 'bad'
  else if (defect === 'worker-failed') data.worker.success = false
  expect(() => inspectBootstrapWorkerResult(data)).toThrow('Windows bootstrap')
})
test('bounded actual worker configuration capture closes its descriptor and preserves immutable source plan DATA', async () => {
  const { readBootstrapWorkerConfiguration } = require('../../../../tools/Brc38WindowsBootstrapWorker.cjs'),
    configuration = await windowsBootstrapWorkerFixture(),
    filename = path.join(directory, 'worker-options.json')
  await fs.writeFile(filename, JSON.stringify(configuration), { flag: 'wx' })
  const plan = await readBootstrapWorkerConfiguration(filename)
  expect(plan.controllerInputs).toEqual(configuration.controllerInputs)
  expect(plan.qualified).toBe(false)
  expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual(configuration)
})
test('failed worker configuration read and close preserve both causes and retry the same actual descriptor', async () => {
  const { readBootstrapWorkerConfiguration } = require('../../../../tools/Brc38WindowsBootstrapWorker.cjs'),
    originalOpen = fs.open,
    filename = path.join(directory, 'worker-options.json'),
    readFailure = new Error('synthetic configuration read failure'),
    closeFailure = new Error('synthetic configuration close failure')
  await fs.writeFile(filename, '{}', { flag: 'wx' })
  let retained
  const opening = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await originalOpen(...args)
    if (String(args[0]) === filename) {
      retained = file
      const close = file.close.bind(file)
      let first = true
      file.read = async () => {
        throw readFailure
      }
      file.close = async () => {
        if (first) {
          first = false
          throw closeFailure
        }
        await close()
      }
    }
    return file
  })
  const failure = await readBootstrapWorkerConfiguration(filename).then(
    () => undefined,
    error => error
  )
  expect(failure).toBeInstanceOf(NativeSourceCleanupError)
  expect(failure.errors).toEqual([readFailure, closeFailure])
  expect(retained.fd).toBeGreaterThanOrEqual(0)
  opening.mockRestore()
  await failure.retryCleanup()
  expect(retained.fd).toBe(-1)
  expect(await fs.readFile(filename, 'utf8')).toBe('{}')
  await failure.retryCleanup()
})
test('a bootstrap process on the wrong host or outside its original root refuses before any child launch', async () => {
  const { runBootstrapWorker } = require('../../../../tools/Brc38WindowsBootstrapWorker.cjs'),
    noExecution = jest.spyOn(require('node:child_process'), 'spawn')
  await expect(runBootstrapWorker('relative-options.json')).rejects.toThrow(/Bootstrap process|Bootstrap options/)
  expect(noExecution).not.toHaveBeenCalled()
  expect(await fs.readdir(directory)).toEqual([])
})

// Standalone bootstrap uses synthetic ELF DATA only in these I/O cases. No
// synthetic image is executed, delivered, or enrolled in the SDK runtime.
async function standaloneFixture() {
  const bytes = targetHeader('linux', process.arch),
    buildDirectory = path.join(directory, 'build'),
    filename = path.join(buildDirectory, 'native-candidate')
  await fs.mkdir(buildDirectory, { mode: 0o700 })
  await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o500 })
  const build = {
    protocol: 'brc38-native-candidate-build/v1',
    platform: process.platform,
    architecture: process.arch,
    engineExecuted: false,
    qualified: false,
    runtimePinChanged: false,
    publicationOrDeployment: false,
    candidate: {
      path: filename,
      bytes: bytes.length,
      sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex')
    }
  }
  return {
    filename,
    build,
    owner: require('../../../../tools/Brc38NativeQualification.cjs').standaloneContractOwner(build, directory)
  }
}
test('standalone bootstrap captures the actual immutable inode, handles partial reads, and grants no SDK authority', async () => {
  const { filename, build, owner } = await standaloneFixture(),
    originalOpen = fs.open
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await originalOpen(...args),
      read = file.read.bind(file)
    if (args[0] === filename)
      file.read = (buffer, offset, length, position) => read(buffer, offset, Math.min(length, 7), position)
    return file
  })
  const file = await owner.open(filename),
    runtime = require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs')
  try {
    expect(await owner.postimage(file)).toEqual({ bytes: build.candidate.bytes, sha256: build.candidate.sha256 })
    expect(await owner.launchPath(file)).toBe('/proc/self/fd/4')
    await expect(runtime.pinnedNativeLaunchPath(file)).rejects.toThrow('original pinned executable descriptor')
    await expect(owner.launchPath(build)).rejects.toThrow('original captured descriptor')
  } finally {
    await owner.close(file)
  }
  await expect(owner.launchPath(file)).rejects.toThrow('original captured descriptor')
})
test.each(['digest', 'writable', 'hardlink', 'symlink'])(
  'standalone %s candidate refuses without launching any process',
  async defect => {
    const { filename, build, owner } = await standaloneFixture(),
      noChild = jest.spyOn(require('node:child_process'), 'spawn')
    if (defect === 'digest') {
      await fs.chmod(filename, 0o700)
      const bytes = await fs.readFile(filename)
      bytes[63] ^= 1
      await fs.writeFile(filename, bytes)
      await fs.chmod(filename, 0o500)
    } else if (defect === 'writable') await fs.chmod(filename, 0o700)
    else if (defect === 'hardlink') await fs.link(filename, path.join(directory, 'alias'))
    else {
      await fs.rename(filename, path.join(directory, 'target'))
      await fs.symlink(path.join(directory, 'target'), filename)
    }
    await expect(owner.open(build.candidate.path)).rejects.toThrow()
    expect(noChild).not.toHaveBeenCalled()
  }
)
test('standalone launch rechecks the captured inode after a mode change', async () => {
  const { filename, owner } = await standaloneFixture(),
    file = await owner.open(filename)
  try {
    await fs.chmod(filename, 0o700)
    await expect(owner.launchPath(file)).rejects.toThrow('identity changed')
  } finally {
    await owner.close(file)
  }
})
test('standalone descriptor-close failure retains the actual descriptor until its concrete retry', async () => {
  const { filename, owner } = await standaloneFixture(),
    file = await owner.open(filename),
    actualClose = file.close.bind(file),
    reason = new Error('close failed')
  file.close = jest.fn().mockRejectedValueOnce(reason).mockImplementation(actualClose)
  const failure = await owner.close(file).catch(error => error)
  expect(failure.cleanupError).toBe(reason)
  expect(file.fd).toBeGreaterThanOrEqual(0)
  expect(await owner.launchPath(file)).toBe('/proc/self/fd/4')
  await failure.retryCleanup()
  await failure.retryCleanup()
  expect(file.fd).toBe(-1)
  expect(file.close).toHaveBeenCalledTimes(2)
  await expect(owner.launchPath(file)).rejects.toThrow('original captured descriptor')
})
test('standalone failed postimage and close preserve both causes and the original retry descriptor', async () => {
  const { filename, owner } = await standaloneFixture(),
    actualOpen = fs.open,
    readFailure = new Error('read failed'),
    closeFailure = new Error('close failed')
  let file
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const opened = await actualOpen(...args)
    if (args[0] === filename) {
      file = opened
      const actualClose = opened.close.bind(opened)
      opened.read = jest.fn().mockRejectedValue(readFailure)
      opened.close = jest.fn().mockRejectedValueOnce(closeFailure).mockImplementation(actualClose)
    }
    return opened
  })
  const failure = await owner.open(filename).catch(error => error)
  expect(failure.cause).toBe(readFailure)
  expect(failure.cleanupError).toBe(closeFailure)
  expect(file.fd).toBeGreaterThanOrEqual(0)
  await failure.retryCleanup()
  expect(file.fd).toBe(-1)
})
test('bootstrap receipt uses exclusive immutable output and preserves paired write/close failures', async () => {
  const { writeQualificationRecord } = require('../../../../tools/Brc38NativeQualification.cjs'),
    filename = path.join(directory, 'receipt.json'),
    actualOpen = fs.open,
    writeFailure = new Error('write failed'),
    closeFailure = new Error('close failed')
  let file
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const opened = await actualOpen(...args)
    if (args[0] === filename) {
      file = opened
      const actualClose = opened.close.bind(opened)
      opened.writeFile = jest.fn().mockRejectedValue(writeFailure)
      opened.close = jest.fn().mockRejectedValueOnce(closeFailure).mockImplementation(actualClose)
    }
    return opened
  })
  const failure = await writeQualificationRecord(filename, { runtimeQualified: false }).catch(error => error)
  expect(failure.cause).toBe(writeFailure)
  expect(failure.cleanupError).toBe(closeFailure)
  expect(file.fd).toBeGreaterThanOrEqual(0)
  await failure.retryCleanup()
  expect(file.fd).toBe(-1)
  expect((await fs.stat(filename)).mode & 0o777).toBe(0o400)
  await expect(writeQualificationRecord(filename, {})).rejects.toThrow()
})
test('bootstrap and delivery CLIs keep distinct strict source-only arguments', () => {
  const {
    parseBootstrapQualificationArguments: bootstrap,
    parseQualificationArguments: delivery
  } = require('../../../../tools/Brc38NativeQualification.cjs')
  expect(bootstrap(['--sqlite-source', '/input/sqlite3.c', '--output-parent', '/private/work'])).toEqual({
    sqliteSource: '/input/sqlite3.c',
    outputParent: '/private/work'
  })
  for (const args of [
    ['--sqlite-source', '/input/sqlite3.c', '--destination', '/private/work'],
    ['--candidate', '/input/native', '--output-parent', '/private/work'],
    ['--sqlite-source', '/input/sqlite3.c', '--output-parent', '/private/../work'],
    ['--sqlite-source', '/input/sqlite3.c', '--output-parent', '/private/work', '--skip-runtime']
  ])
    expect(() => bootstrap(args)).toThrow()
  expect(() => delivery(['--sqlite-source', '/input/sqlite3.c', '--output-parent', '/private/work'])).toThrow()
})

// Foreign target plans remain DATA. Path cases exercise real filesystem I/O on
// the current controlled Linux worker, without executing any synthetic image.
test.each(['arm64', 'x64'])(
  'Darwin %s first-artifact plan uses its private build path and never invents a Docker target',
  architecture => {
    const { planUnixBootstrapHost } = require('../../../../tools/Brc38NativeQualification.cjs'),
      noChild = jest.spyOn(require('node:child_process'), 'spawn'),
      plan = planUnixBootstrapHost('darwin', architecture, 'v24.18.0', '137')
    expect(plan).toEqual({
      platform: 'darwin',
      architecture,
      nodeVersion: 'v24.18.0',
      nodeABI: '137',
      launchMechanism: 'private-darwin-build-path'
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(plan.dockerPlatform).toBeUndefined()
    expect(noChild).not.toHaveBeenCalled()
  }
)
test.each([
  ['win32', 'arm64', 'v24.18.0', '137'],
  ['win32', 'x64', 'v24.18.0', '137'],
  ['darwin', 'ia32', 'v24.18.0', '137'],
  ['darwin', 'x86_64', 'v24.18.0', '137'],
  ['darwin', 'arm64', 'v24.17.0', '137'],
  ['darwin', 'x64', 'v24.18.0', '136']
])('unsupported Unix first-artifact target %s/%s/%s/%s refuses before process or path work', (...target) => {
  const { planUnixBootstrapHost } = require('../../../../tools/Brc38NativeQualification.cjs'),
    noPath = jest.spyOn(fs, 'lstat'),
    noChild = jest.spyOn(require('node:child_process'), 'spawn')
  expect(() => planUnixBootstrapHost(...target)).toThrow('controlled Unix ARM64/x64 Node24.18.0 ABI137 worker')
  expect(noPath).not.toHaveBeenCalled()
  expect(noChild).not.toHaveBeenCalled()
})
test('standalone private path comparison binds the actual original inode and private directory without SDK authority', async () => {
  const { filename } = await standaloneFixture(),
    { standaloneBuildPath } = require('../../../../tools/Brc38NativeQualification.cjs'),
    file = await fs.open(filename, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW),
    originalDirectory = await fs.lstat(path.dirname(filename), { bigint: true })
  try {
    expect(await standaloneBuildPath(file, filename, originalDirectory)).toBe(filename)
    await expect(
      require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs').pinnedNativeLaunchPath(file)
    ).rejects.toThrow('original pinned executable descriptor')
  } finally {
    await file.close()
  }
})
test.each(['replacement', 'symlink', 'directory-replacement', 'writable'])(
  'standalone private %s path cannot replace the original captured descriptor',
  async defect => {
    const { filename } = await standaloneFixture(),
      { standaloneBuildPath } = require('../../../../tools/Brc38NativeQualification.cjs'),
      file = await fs.open(filename, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW),
      originalDirectory = await fs.lstat(path.dirname(filename), { bigint: true })
    try {
      if (defect === 'directory-replacement') {
        const relocated = path.join(directory, 'relocated')
        await fs.rename(path.dirname(filename), relocated)
        await fs.mkdir(path.dirname(filename), { mode: 0o700 })
        await fs.copyFile(path.join(relocated, 'native-candidate'), filename)
        await fs.chmod(filename, 0o500)
      } else if (defect === 'writable') await fs.chmod(filename, 0o700)
      else {
        const retained = path.join(directory, 'retained')
        await fs.rename(filename, retained)
        if (defect === 'replacement') {
          await fs.copyFile(retained, filename)
          await fs.chmod(filename, 0o500)
        } else await fs.symlink(retained, filename)
      }
      await expect(standaloneBuildPath(file, filename, originalDirectory)).rejects.toThrow()
      expect(file.fd).toBeGreaterThanOrEqual(0)
    } finally {
      await file.close()
    }
  }
)
test('standalone private path comparison refuses a descriptor after actual close', async () => {
  const { filename } = await standaloneFixture(),
    { standaloneBuildPath } = require('../../../../tools/Brc38NativeQualification.cjs'),
    file = await fs.open(filename, 'r'),
    originalDirectory = await fs.lstat(path.dirname(filename), { bigint: true })
  await file.close()
  await expect(standaloneBuildPath(file, filename, originalDirectory)).rejects.toThrow('still-open original descriptor')
})
