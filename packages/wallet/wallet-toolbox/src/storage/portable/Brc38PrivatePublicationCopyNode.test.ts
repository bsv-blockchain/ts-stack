import { createHash } from 'node:crypto'
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
})
