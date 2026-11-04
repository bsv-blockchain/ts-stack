'use strict'
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const { parseQualificationArguments, qualifyBrc38NativeCandidate } = require('../../tools/Brc38NativeQualification.cjs')

test.each(
  [
    [],
    ['--help'],
    ['--sqlite-source', '/input/sqlite3.c'],
    ['--source', '/input/sqlite3.c', '--destination', '/private/native-contract'],
    ['--destination', '/private/native-contract', '--sqlite-source', '/input/sqlite3.c'],
    ['--sqlite-source', '/input/sqlite3.c', '--destination', '/private/native-contract', '--skip-runtime'],
    ['--sqlite-source', '/input/sqlite3.c', '--destination', '/private/native-contract', '--update-pin'],
    ['--sqlite-source', '/input/sqlite3.c', '--destination', '/private/native-contract', '--increase-limit']
  ].map(args => [args])
)('qualification CLI refuses ungoverned arguments %j', args => {
  expect(() => parseQualificationArguments(args)).toThrow('Usage:')
})

test.each([
  ['sqlite3.c', '/private/native-contract'],
  ['/input/sqlite3.c', 'native-contract'],
  ['/input/../sqlite3.c', '/private/native-contract'],
  ['/input/sqlite3.c', '/private//native-contract'],
  ['/input/sqlite3.c', '/private/native-contract\0'],
  ['/input/sqlite3.c', '/input/sqlite3.c']
])('qualification CLI refuses ambiguous source/destination coordinates %j', (source, destination) => {
  expect(() => parseQualificationArguments(['--sqlite-source', source, '--destination', destination])).toThrow()
})

test('actual exclusive delivery refusal preserves a pre-existing file and creates no build root', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-delivery-refusal-')),
    destination = path.join(directory, 'native-contract'),
    sentinel = Buffer.from('independent existing delivery')
  try {
    await fs.writeFile(destination, sentinel, { flag: 'wx', mode: 0o600 })
    const file = await fs.open(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const before = await file.stat({ bigint: true })
      await expect(
        qualifyBrc38NativeCandidate({ sqliteSource: path.join(directory, 'absent-sqlite3.c'), destination })
      ).rejects.toThrow(/requires its admitted Linux ARM64|destination already exists/)
      const after = await fs.lstat(destination, { bigint: true })
      expect(after.dev).toBe(before.dev)
      expect(after.ino).toBe(before.ino)
      expect(after.size).toBe(before.size)
      expect(after.mtimeNs).toBe(before.mtimeNs)
      expect(await file.readFile()).toEqual(sentinel)
      expect(await fs.readdir(directory)).toEqual(['native-contract'])
    } finally {
      await file.close()
    }
  } finally {
    await fs.rm(directory, { recursive: true })
  }
})

test('real CLI argument failure exits without touching its destination', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-delivery-cli-')),
    destination = path.join(directory, 'native-contract'),
    sentinel = Buffer.from('independent CLI sentinel'),
    tool = path.resolve(__dirname, '../../tools/Brc38NativeQualification.cjs')
  try {
    await fs.writeFile(destination, sentinel, { flag: 'wx', mode: 0o600 })
    const child = cp.spawn(
      process.execPath,
      [
        '--max-old-space-size=1536',
        tool,
        '--sqlite-source',
        '/unread-source/sqlite3.c',
        '--destination',
        destination,
        '--skip-runtime'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    )
    let bytes = 0,
      stdout = '',
      stderr = '',
      expired = false
    const signal = () => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (cause) {
          if (cause.code !== 'ESRCH') throw cause
        }
      },
      timer = setTimeout(() => {
        expired = true
        signal()
      }, 10000)
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 65536) signal()
      else stdout += chunk
    })
    child.stderr.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 65536) signal()
      else stderr += chunk
    })
    let result
    try {
      result = await new Promise((resolve, reject) => {
        child.on('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
    } finally {
      clearTimeout(timer)
    }
    expect(expired).toBe(false)
    expect(bytes).toBeLessThanOrEqual(65536)
    expect(result).toEqual({ code: 1, signal: null })
    expect(stdout).toBe('')
    expect(stderr).toContain('Usage:')
    expect(() => process.kill(-child.pid, 0)).toThrow()
    expect(await fs.readFile(destination)).toEqual(sentinel)
    expect(await fs.readdir(directory)).toEqual(['native-contract'])
  } finally {
    await fs.rm(directory, { recursive: true })
  }
})

test('compatibility CLI cohort-file reader binds metadata and bytes to one descriptor, closes it and preserves symlink inputs', async () => {
  const { readWalletSyncCohorts } = require('../compatibility/releasedWalletSync.cjs')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-cohorts-reader-')),
    filename = path.join(directory, 'cohorts.json'),
    alias = path.join(directory, 'cohorts-link.json'),
    expected = { releasedSdk2: { directory: '/independent/fixture' }, original: true }
  const originalOpen = fs.open,
    handles = [],
    spy = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await originalOpen(...args)
      handles.push(file)
      return file
    })
  try {
    await fs.writeFile(filename, JSON.stringify(expected), { flag: 'wx', mode: 0o600 })
    await fs.symlink(filename, alias)
    expect(await readWalletSyncCohorts(filename)).toEqual(expected)
    expect(await readWalletSyncCohorts(alias)).toEqual(expected)
    expect(handles).toHaveLength(2)
    expect(handles.every(file => file.fd === -1)).toBe(true)
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(32769, 32), Buffer.from('{]')]) {
      await fs.writeFile(filename, bytes)
      await expect(readWalletSyncCohorts(filename)).rejects.toThrow()
      expect(handles.at(-1).fd).toBe(-1)
    }
  } finally {
    spy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
