import { createHash } from 'node:crypto'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hashBrc38PublishedDatabase, copyBrc38OwnedDatabase } from './Brc38PrivatePublicationCopyNode'
import {
  assertBrc38ProfileFileDescriptor,
  captureBrc38ProfilePhysicalIdentity
} from './Brc38ProfilePhysicalIdentityNode'

describe('publication verification binds the actual opened descriptor', () => {
  let directory: string
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'brc38-descriptor-receipt-'))
    for (const name of ['owner.sqlite', 'profile.sqlite', 'wallet.sqlite']) {
      const file = await fs.open(join(directory, name), 'wx', 0o600)
      try {
        await file.write(Buffer.alloc(4096, 37))
      } finally {
        await file.close()
      }
    }
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await fs.rm(directory, { recursive: true })
  })
  test('hashes the original owned descriptor using its exact persisted device/inode receipt', async () => {
    const identity = await captureBrc38ProfilePhysicalIdentity(directory, true)
    expect(await hashBrc38PublishedDatabase(join(directory, 'wallet.sqlite'), 4096, identity.wallet)).toBe(
      createHash('sha256').update(Buffer.alloc(4096, 37)).digest('hex')
    )
  })
  test('copy binds its actual original descriptor before target creation and rechecks it before returning', async () => {
    const identity = await captureBrc38ProfilePhysicalIdentity(directory, true),
      target = join(directory, 'copy.sqlite')
    let observations = 0
    const copied = await copyBrc38OwnedDatabase(
      join(directory, 'wallet.sqlite'),
      target,
      4096,
      Date.now() + 60000,
      () => undefined,
      undefined,
      async source => {
        await assertBrc38ProfileFileDescriptor(source, identity.wallet!)
        observations++
      }
    )
    expect(observations).toBe(2)
    expect(copied).toEqual({ bytes: 4096, sha256: createHash('sha256').update(Buffer.alloc(4096, 37)).digest('hex') })
    expect(await fs.readFile(target)).toEqual(Buffer.alloc(4096, 37))
  })
  test('same-byte source replacement refuses its old descriptor binding before creating any target', async () => {
    const identity = await captureBrc38ProfilePhysicalIdentity(directory, true),
      source = join(directory, 'wallet.sqlite'),
      target = join(directory, 'copy.sqlite')
    await fs.rename(source, source + '.original')
    await fs.copyFile(source + '.original', source)
    await expect(
      copyBrc38OwnedDatabase(
        source,
        target,
        4096,
        Date.now() + 60000,
        () => undefined,
        undefined,
        async file => await assertBrc38ProfileFileDescriptor(file, identity.wallet!)
      )
    ).rejects.toThrow('opened descriptor identity differs')
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test.each(['device', 'inode'] as const)(
    'a differing recorded %s refuses before payload reads and closes the descriptor',
    async field => {
      const identity = await captureBrc38ProfilePhysicalIdentity(directory, true)
      const wanted = {
        ...identity.wallet!,
        [field]: (BigInt(identity.wallet![field]) + 1n).toString()
      }
      const actualOpen = fs.open
      let held: Awaited<ReturnType<typeof fs.open>> | undefined
      const read = jest.fn()
      const opened = jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
        held = await actualOpen(...args)
        jest.spyOn(held, 'read').mockImplementation(read)
        return held
      })
      try {
        await expect(hashBrc38PublishedDatabase(join(directory, 'wallet.sqlite'), 4096, wanted)).rejects.toThrow(
          'opened descriptor identity differs'
        )
        expect(read).not.toHaveBeenCalled()
        expect(held?.fd).toBe(-1)
      } finally {
        opened.mockRestore()
        await held?.close()
      }
    }
  )
  test('exact integer receipts above Number precision are refused without rounding to the actual descriptor', async () => {
    const identity = await captureBrc38ProfilePhysicalIdentity(directory, true)
    const file = await fs.open(join(directory, 'wallet.sqlite'), 'r')
    try {
      await expect(
        assertBrc38ProfileFileDescriptor(file, { ...identity.wallet!, inode: '9007199254740993' })
      ).rejects.toThrow('opened descriptor identity differs')
      await expect(assertBrc38ProfileFileDescriptor(file, { ...identity.wallet!, inode: '-1' })).rejects.toThrow(
        'binding is incomplete'
      )
    } finally {
      await file.close()
    }
  })
  test('a valid legacy receipt without descriptor metadata retains its exact hash and size bound', async () => {
    const filename = join(directory, 'wallet.sqlite')
    expect(await hashBrc38PublishedDatabase(filename, 4096)).toBe(
      createHash('sha256').update(Buffer.alloc(4096, 37)).digest('hex')
    )
    await expect(hashBrc38PublishedDatabase(filename, 4095)).rejects.toThrow('physical policy')
  })
  test('descriptor private modes remain required with an otherwise matching identity', async () => {
    const identity = await captureBrc38ProfilePhysicalIdentity(directory, true)
    await fs.chmod(join(directory, 'wallet.sqlite'), 0o400)
    const actual = await fs.lstat(join(directory, 'wallet.sqlite'), { bigint: true })
    expect({ device: actual.dev.toString(), inode: actual.ino.toString() }).toEqual(identity.wallet)
    expect(actual.mode & 0o777n).toBe(0o400n)
    await expect(hashBrc38PublishedDatabase(join(directory, 'wallet.sqlite'), 4096, identity.wallet)).rejects.toThrow(
      'Actual Unix private ownership or mode differs'
    )
  })
  test('a native descriptor metadata error retains the original cause and closes the file', async () => {
    const identity = await captureBrc38ProfilePhysicalIdentity(directory, true),
      cause = new Error('controlled descriptor metadata failure')
    const actualOpen = fs.open
    let held: Awaited<ReturnType<typeof fs.open>> | undefined
    const opened = jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      held = await actualOpen(...args)
      jest.spyOn(held, 'stat').mockRejectedValueOnce(cause)
      return held
    })
    try {
      await expect(hashBrc38PublishedDatabase(join(directory, 'wallet.sqlite'), 4096, identity.wallet)).rejects.toBe(
        cause
      )
      expect(held?.fd).toBe(-1)
    } finally {
      opened.mockRestore()
      await held?.close()
    }
  })
  type Descriptor = Awaited<ReturnType<typeof fs.open>>
  function trackDescriptors(configure?: (file: Descriptor, name: string) => void): Descriptor[] {
    const files: Descriptor[] = [],
      actualOpen = fs.open
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await actualOpen(...args)
      files.push(file)
      configure?.(file, String(args[0]))
      return file
    })
    return files
  }
  async function releaseDescriptors(files: Descriptor[]): Promise<void> {
    for (const file of files) {
      try {
        await file.close()
      } catch {
        await file.close()
      }
    }
  }

  test('the exact original deadline refuses before source ownership and target creation', async () => {
    const expiresAt = Date.now(),
      owner = jest.fn(),
      target = join(directory, 'copy.sqlite')
    jest.spyOn(Date, 'now').mockReturnValue(expiresAt)
    await expect(
      copyBrc38OwnedDatabase(join(directory, 'wallet.sqlite'), target, 4096, expiresAt, owner)
    ).rejects.toThrow('Original private publication deadline expired')
    expect(owner).not.toHaveBeenCalled()
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each([0, 4095, 4096.5, NaN, Infinity])('invalid fixed physical cap %s refuses both primitives', async cap => {
    const source = join(directory, 'wallet.sqlite'),
      target = join(directory, 'copy.sqlite')
    await expect(copyBrc38OwnedDatabase(source, target, cap, Date.now() + 60000, () => undefined)).rejects.toThrow(
      'Publication source file exceeds its owned physical policy'
    )
    await expect(hashBrc38PublishedDatabase(source, cap)).rejects.toThrow(
      'Published profile file exceeds its physical policy'
    )
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a physically undersized file cannot become a copied or hashed profile', async () => {
    const source = join(directory, 'wallet.sqlite'),
      target = join(directory, 'copy.sqlite')
    await fs.truncate(source, 4095)
    await expect(copyBrc38OwnedDatabase(source, target, 4096, Date.now() + 60000, () => undefined)).rejects.toThrow(
      'Publication source file exceeds its owned physical policy'
    )
    await expect(hashBrc38PublishedDatabase(source, 4096)).rejects.toThrow(
      'Published profile file exceeds its physical policy'
    )
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each(['copy-read', 'copy-write', 'hash-read'] as const)(
    '%s refuses an incomplete actual I/O result and drains descriptors',
    async mode => {
      const source = join(directory, 'wallet.sqlite'),
        target = join(directory, 'copy.sqlite')
      const files = trackDescriptors((file, name) => {
        if (mode === 'copy-write' && name === target) {
          const write = file.write
          jest.spyOn(file, 'write').mockImplementationOnce(async (...args) => {
            const result = await Reflect.apply(write, file, args)
            return { ...result, bytesWritten: result.bytesWritten - 1 }
          })
        } else if (mode !== 'copy-write' && name === source) {
          const read = file.read
          jest.spyOn(file, 'read').mockImplementationOnce(async (...args) => {
            const result = await Reflect.apply(read, file, args)
            return { ...result, bytesRead: result.bytesRead - 1 }
          })
        }
      })
      try {
        const operation =
          mode === 'hash-read'
            ? hashBrc38PublishedDatabase(source, 4096)
            : copyBrc38OwnedDatabase(source, target, 4096, Date.now() + 60000, () => undefined)
        await expect(operation).rejects.toThrow(
          mode === 'hash-read'
            ? 'Published profile read was incomplete'
            : mode === 'copy-write'
              ? 'Publication target write was incomplete'
              : 'Publication source changed during bounded copy'
        )
        expect(files.every(file => file.fd === -1)).toBe(true)
      } finally {
        await releaseDescriptors(files)
      }
    }
  )

  test.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'target-size'] as const)(
    'copy independently refuses changed %s metadata from the actual descriptor',
    async field => {
      const source = join(directory, 'wallet.sqlite'),
        target = join(directory, 'copy.sqlite')
      const files = trackDescriptors((file, name) => {
        if (name !== (field === 'target-size' ? target : source)) return
        const stat = file.stat
        let calls = 0
        jest.spyOn(file, 'stat').mockImplementation(async (...args) => {
          const actual = await Reflect.apply(stat, file, args)
          // The real stat executes first. Corrupt only its returned DATA; no
          // fabricated file or positive ownership verdict enters this test.
          if (field === 'target-size' ? actual.size === 4096n : ++calls === 2) {
            const key = field === 'target-size' ? 'size' : field
            Reflect.set(actual, key, Reflect.get(actual, key) + 1n)
          }
          return actual
        })
      })
      try {
        await expect(copyBrc38OwnedDatabase(source, target, 4096, Date.now() + 60000, () => undefined)).rejects.toThrow(
          'Publication file identity changed during copy'
        )
        expect(files.every(file => file.fd === -1)).toBe(true)
      } finally {
        await releaseDescriptors(files)
      }
    }
  )

  test.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)(
    'hash independently refuses changed %s metadata from the actual descriptor',
    async field => {
      const files = trackDescriptors(file => {
        const stat = file.stat
        let calls = 0
        jest.spyOn(file, 'stat').mockImplementation(async (...args) => {
          const actual = await Reflect.apply(stat, file, args)
          if (++calls === 2) Reflect.set(actual, field, Reflect.get(actual, field) + 1n)
          return actual
        })
      })
      try {
        await expect(hashBrc38PublishedDatabase(join(directory, 'wallet.sqlite'), 4096)).rejects.toThrow(
          'Published profile changed during verification'
        )
        expect(files.every(file => file.fd === -1)).toBe(true)
      } finally {
        await releaseDescriptors(files)
      }
    }
  )

  test.each(['copy', 'hash'] as const)(
    '%s retains the original failure and concrete failed descriptor close for retry',
    async mode => {
      const primary = new Error('original publication operation failed'),
        closing = new Error('actual descriptor close failed')
      const files = trackDescriptors(file => {
        jest.spyOn(file, 'close').mockRejectedValueOnce(closing)
      })
      let observations = 0
      const refuse = () => {
        if (++observations === (mode === 'copy' ? 2 : 1)) throw primary
      }
      try {
        const operation =
          mode === 'copy'
            ? copyBrc38OwnedDatabase(
                join(directory, 'wallet.sqlite'),
                join(directory, 'copy.sqlite'),
                4096,
                Date.now() + 60000,
                refuse
              )
            : hashBrc38PublishedDatabase(join(directory, 'wallet.sqlite'), 4096, undefined, refuse)
        const failure: unknown = await operation.then(
          () => undefined,
          cause => cause
        )
        expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
        if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Actual cleanup owner was lost')
        expect(failure.message).toBe('Publication retains original file descriptors')
        expect(failure.errors[0]).toBe(primary)
        const combined = failure.errors[1] as AggregateError
        expect(combined).toBeInstanceOf(AggregateError)
        expect(combined.message).toBe('Publication file cleanup failed')
        expect(combined.errors).toEqual([closing])
        expect(files).toHaveLength(1)
        expect(files[0].fd).toBeGreaterThanOrEqual(0)
        await failure.retryCleanup()
        expect(files[0].fd).toBe(-1)
      } finally {
        await releaseDescriptors(files)
      }
    }
  )

  test('a successful copy retains a failed source close without inventing an operation cause', async () => {
    const closing = new Error('actual successful-copy close failed')
    const source = join(directory, 'wallet.sqlite'),
      target = join(directory, 'copy.sqlite')
    const files = trackDescriptors((file, name) => {
      if (name === source) jest.spyOn(file, 'close').mockRejectedValueOnce(closing)
    })
    try {
      const failure: unknown = await copyBrc38OwnedDatabase(
        source,
        target,
        4096,
        Date.now() + 60000,
        () => undefined
      ).then(
        () => undefined,
        cause => cause
      )
      expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
      if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Actual copy close owner was lost')
      expect(failure.errors).toHaveLength(1)
      expect((failure.errors[0] as AggregateError).errors).toEqual([closing])
      expect(await fs.readFile(target)).toEqual(Buffer.alloc(4096, 37))
      await failure.retryCleanup()
      expect(files.every(file => file.fd === -1)).toBe(true)
    } finally {
      await releaseDescriptors(files)
    }
  })

  test('a primary cleanup failure keeps its own real descriptor owner after the copy descriptor drains', async () => {
    const owner = await fs.open(join(directory, 'profile.sqlite'), 'r'),
      cause = new Error('prior owner close failed')
    const close = jest.spyOn(owner, 'close').mockRejectedValueOnce(cause)
    const primary = new Brc38StagingCleanupError([cause], 'Original owner retains cleanup', async () => {
      await owner.close()
    })
    const files = trackDescriptors()
    try {
      const failure: unknown = await hashBrc38PublishedDatabase(
        join(directory, 'wallet.sqlite'),
        4096,
        undefined,
        () => {
          throw primary
        }
      ).then(
        () => undefined,
        failure => failure
      )
      expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
      if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Prior descriptor owner was lost')
      expect(failure.errors[0]).toBe(primary)
      expect((failure.errors[1] as AggregateError).errors).toEqual([cause])
      expect(files.every(file => file.fd === -1)).toBe(true)
      expect(owner.fd).toBeGreaterThanOrEqual(0)
      await failure.retryCleanup()
      expect(owner.fd).toBe(-1)
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      await owner.close()
      await releaseDescriptors(files)
    }
  })
})
