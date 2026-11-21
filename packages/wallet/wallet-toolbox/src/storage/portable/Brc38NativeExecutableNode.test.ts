import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

interface ExecutableApi {
  openPinnedNativeExecutable: (filename: string) => Promise<FileHandle>
  pinnedNativeLaunchPath: (file: FileHandle) => Promise<string>
  closePinnedNativeExecutable: (file: FileHandle) => Promise<void>
  componentBuild: Readonly<{ platform: string; architecture: string; bytes: number; sha256: string }>
}
const native: ExecutableApi = require('./Brc38NativeExecutable.cjs')
const fs: typeof import('node:fs/promises') = require('node:fs/promises')

afterEach(() => jest.restoreAllMocks())

// Authored UNRUN. Negative file/identity boundaries only; no native process,
// substituted platform, candidate qualification or privileged installation.
test('a caller-shaped file cannot invoke stat or become an executable launch owner', async () => {
  const stat = jest.fn(() => {
    throw new Error('Forged descriptor must not be consulted')
  })
  const shaped = Object.create(null) as FileHandle
  Object.defineProperty(shaped, 'stat', { get: stat })
  await expect(native.pinnedNativeLaunchPath(shaped)).rejects.toThrow('original pinned executable descriptor')
  expect(stat).not.toHaveBeenCalled()
  const close = jest.fn(() => {
    throw new Error('Forged close must not be consulted')
  })
  Object.defineProperty(shaped, 'close', { get: close })
  await expect(native.closePinnedNativeExecutable(shaped)).rejects.toThrow('original factory descriptor')
  expect(close).not.toHaveBeenCalled()
})

test('replacing exported build metadata cannot admit different actual executable bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-executable-refusal-'))
  const filename = join(directory, 'candidate'),
    original = native.componentBuild
  const bytes = new Uint8Array(original.bytes),
    actualOpen = fs.open
  const opened: FileHandle[] = []
  try {
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o500 })
    await chmod(filename, 0o500)
    Reflect.set(
      native,
      'componentBuild',
      Object.freeze({
        ...original,
        platform: process.platform,
        architecture: process.arch,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    )
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await actualOpen(...args)
      opened.push(file)
      return file
    })
    await expect(native.openPinnedNativeExecutable(filename)).rejects.toThrow(
      process.platform === original.platform && process.arch === original.architecture
        ? 'differs from its fixed build'
        : 'platform is not qualified'
    )
    expect(opened).toHaveLength(
      process.platform === original.platform && process.arch === original.architecture ? 1 : 0
    )
    for (const file of opened) {
      await expect(file.stat()).rejects.toMatchObject({ code: 'EBADF' })
      await expect(native.pinnedNativeLaunchPath(file)).rejects.toThrow('original pinned executable descriptor')
    }
  } finally {
    Reflect.set(native, 'componentBuild', original)
    jest.restoreAllMocks()
    await Promise.allSettled(opened.map(file => file.close()))
    await rm(directory, { recursive: true, force: true })
  }
})
