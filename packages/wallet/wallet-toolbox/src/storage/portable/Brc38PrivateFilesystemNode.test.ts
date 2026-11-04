import { mkdtemp, rm, symlink, link, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import {
  createPrivateFile,
  requirePrivatePath,
  requirePrivateDescriptor,
  syncPrivateDirectory,
  Brc38PrivateFilesystemCleanupError
} from './Brc38PrivateFilesystemNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

// Authored UNRUN actual Unix file/descriptor cases. They do not impersonate
// Windows or substitute chmod for HANDLE/DACL qualification on that platform.
const unixCase = process.platform === 'win32' ? test.skip : test
const fs: typeof import('node:fs/promises') = require('node:fs/promises')
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'brc38-private-filesystem-'))
})
afterEach(async () => {
  jest.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

unixCase('creation checks original descriptor/path identity and keeps IDs exact through directory flush', async () => {
  const filename = join(directory, 'private'),
    file = await createPrivateFile(filename, true)
  try {
    await file.writeFile('private bytes')
    await file.sync()
    const held = await requirePrivateDescriptor(file),
      named = await requirePrivatePath(filename, false)
    expect(typeof held.dev).toBe('bigint')
    expect(typeof held.ino).toBe('bigint')
    expect([held.dev, held.ino, held.size]).toEqual([named.dev, named.ino, 13n])
    await syncPrivateDirectory(directory)
  } finally {
    await file.close()
  }
})
unixCase('refuses a symlink, extra hard link and broadened private permissions', async () => {
  const filename = join(directory, 'private'),
    file = await createPrivateFile(filename)
  await file.close()
  await symlink(filename, join(directory, 'symlink'))
  await expect(requirePrivatePath(join(directory, 'symlink'), false)).rejects.toThrow('type or link count')
  await link(filename, join(directory, 'second-link'))
  await expect(requirePrivatePath(filename, false)).rejects.toThrow('type or link count')
  await fs.unlink(join(directory, 'second-link'))
  await chmod(filename, 0o640)
  await expect(requirePrivatePath(filename, false)).rejects.toThrow('ownership or mode')
})
unixCase(
  'failed directory flush teardown retains the same actual descriptor until shared retry physically closes it',
  async () => {
    const originalOpen = fs.open,
      refusal = new Error('original directory close refused')
    let original: FileHandle | undefined,
      closes = 0
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await originalOpen(...args)
      if (args[0] === directory) {
        original = file
        const close = file.close.bind(file)
        file.close = async () => {
          if (closes++ < 2) throw refusal
          await close()
        }
      }
      return file
    })
    const failure = await syncPrivateDirectory(directory).then(
      () => undefined,
      cause => cause
    )
    expect(failure).toBeInstanceOf(Brc38PrivateFilesystemCleanupError)
    expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
    expect(original).toBeDefined()
    expect((await original!.stat()).isDirectory()).toBe(true)
    const first = failure.retryCleanup(),
      same = failure.retryCleanup()
    expect(first).toBe(same)
    await expect(first).rejects.toBe(refusal)
    expect((await original!.stat()).isDirectory()).toBe(true)
    await failure.retryCleanup()
    expect(failure.cleaned).toBe(true)
    await expect(original!.stat()).rejects.toMatchObject({ code: 'EBADF' })
    await failure.retryCleanup()
    expect(closes).toBe(3)
  }
)
