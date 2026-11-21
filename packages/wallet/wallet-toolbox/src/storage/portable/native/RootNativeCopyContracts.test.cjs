'use strict'

// The original eight Linux root-copy cases run as the root installer, separately
// from ordinary wallet consumers. CI requires their complete same-head report.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
let directory
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-root-copy-'))
})
afterEach(async () => {
  jest.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

async function rootCopyFixture() {
  const source = process.env.TS_STACK_NATIVE_TEST_EXECUTABLE,
    destination = path.join(directory, 'root-copy')
  expect(process.platform).toBe('linux')
  expect(process.getuid()).toBe(0)
  expect(typeof source).toBe('string')
  await fs.mkdir(destination, { mode: 0o700 })
  return { source, destination, output: path.join(destination, 'native-contract') }
}
async function readRootCopy(filename) {
  const file = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    return { stat: await file.stat(), bytes: await file.readFile() }
  } finally {
    await file.close()
  }
}
test('actual Linux root file-copy fixture preserves exact bytes, closes descriptors and conveys no Darwin ACL grant', async () => {
  const fixture = await rootCopyFixture(),
    copy = require('../../../../tools/Brc38RootNativeInstallation.cjs').copyPinnedRootOwnedExecutable,
    result = await copy(fixture.source, fixture.destination),
    pin = require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs').qualifiedNativeComponentBuild(),
    opened = await readRootCopy(fixture.output),
    actual = opened.stat
  expect(opened.bytes).toEqual(await fs.readFile(fixture.source))
  expect(actual.mode & 0o777).toBe(0o555)
  expect(actual.uid).toBe(0)
  expect(actual.nlink).toBe(1)
  expect(result.pin).toBe(pin)
  expect(result.engineExecuted).toBe(false)
  expect(result.runtimeAdmitted).toBe(false)
  expect(result.darwinACLQualified).toBe(false)
  expect(result.fullSystemQualified).toBe(false)
  await expect(
    require('../../../../out/src/storage/portable/Brc38NativeExecutable.cjs').pinnedNativeLaunchPath(result)
  ).rejects.toThrow('original pinned executable descriptor')
  await expect(copy(fixture.source, fixture.destination)).rejects.toThrow()
  const retained = await readRootCopy(fixture.output)
  expect([retained.stat.dev, retained.stat.ino]).toEqual([actual.dev, actual.ino])
  expect(retained.bytes).toEqual(await fs.readFile(fixture.source))
})
test.each(['symlink', 'writable', 'hard-link', 'truncated', 'corrupted'])(
  'actual root-copy %s source refuses; only a newly created failed file may remain',
  async defect => {
    const f = await rootCopyFixture(),
      source = path.join(directory, 'candidate')
    if (defect === 'symlink') await fs.symlink(f.source, source)
    else {
      const bytes = await fs.readFile(f.source)
      if (defect === 'corrupted') bytes[bytes.length - 1] ^= 1
      await fs.writeFile(source, defect === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes, { mode: 0o500 })
      if (defect === 'writable') await fs.chmod(source, 0o700)
      if (defect === 'hard-link') await fs.link(source, path.join(directory, 'candidate-link'))
    }
    await expect(
      require('../../../../tools/Brc38RootNativeInstallation.cjs').copyPinnedRootOwnedExecutable(source, f.destination)
    ).rejects.toThrow()
    if (defect === 'corrupted') expect((await fs.lstat(f.output)).mode & 0o777).toBe(0o500)
    else expect(await fs.readdir(f.destination)).toEqual([])
  }
)
test('a replaced root-copy parent refuses before creating a file in either directory', async () => {
  const f = await rootCopyFixture(),
    original = fs.open,
    saved = f.destination + '-original'
  let changed = false
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (!changed && args[0] === f.source) {
      changed = true
      await fs.rename(f.destination, saved)
      await fs.mkdir(f.destination, { mode: 0o700 })
    }
    return handle
  })
  await expect(
    require('../../../../tools/Brc38RootNativeInstallation.cjs').copyPinnedRootOwnedExecutable(f.source, f.destination)
  ).rejects.toThrow('directory identity')
  expect(await fs.readdir(f.destination)).toEqual([])
  expect(await fs.readdir(saved)).toEqual([])
})
test('root-copy failed close retains the actual descriptor and blocks another copy until idempotent retry', async () => {
  const f = await rootCopyFixture(),
    original = fs.open,
    reason = new Error('synthetic root-copy close refusal')
  let retainedHandle,
    attempts = 0
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (args[0] === f.output) {
      retainedHandle = handle
      const close = handle.close.bind(handle)
      handle.close = async () => {
        if (++attempts === 1) throw reason
        return close()
      }
    }
    return handle
  })
  const copy = require('../../../../tools/Brc38RootNativeInstallation.cjs').copyPinnedRootOwnedExecutable,
    failure = await copy(f.source, f.destination).catch(e => e)
  expect(failure).toBeInstanceOf(
    require('../../../../tools/Brc38NativeCandidateBuild.cjs').NativeCandidateBuildCleanupError
  )
  expect(failure.cleanupError.errors).toContain(reason)
  expect(retainedHandle.fd).toBeGreaterThanOrEqual(0)
  await expect(copy(f.source, f.destination)).rejects.toThrow('descriptors remain retained')
  await failure.retryCleanup()
  await failure.retryCleanup()
  expect(attempts).toBe(2)
  expect(retainedHandle.fd).toBe(-1)
  expect(failure.cleaned).toBe(true)
})
