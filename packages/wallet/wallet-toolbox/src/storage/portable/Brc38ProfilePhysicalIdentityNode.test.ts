import { chmod, lstat, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertBrc38ProfilePhysicalIdentity,
  assertBrc38RetiringProfilePhysicalIdentity,
  captureBrc38ProfilePhysicalIdentity,
  validBrc38ProfilePhysicalIdentity
} from './Brc38ProfilePhysicalIdentityNode'
import { runInSeries } from '../../utility/runInSeries'

describe('actual private profile physical identity metadata', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brc38-physical-identity-'))
    await runInSeries(['owner.sqlite', 'profile.sqlite', 'wallet.sqlite'], async name => {
      const file = await open(join(directory, name), 'wx', 0o600)
      await file.close()
    })
  })
  afterEach(async () => await rm(directory, { recursive: true, force: true }))
  test('captures exact bigint filesystem identity without rounding and verifies every original file', async () => {
    const original = await captureBrc38ProfilePhysicalIdentity(directory, true)
    expect(Object.isFrozen(original)).toBe(true)
    for (const [key, name] of Object.entries({
      directory: '',
      owner: 'owner.sqlite',
      catalog: 'profile.sqlite',
      wallet: 'wallet.sqlite'
    })) {
      const stat = await lstat(join(directory, name), { bigint: true })
      expect(original[key as keyof typeof original]).toEqual({
        device: stat.dev.toString(),
        inode: stat.ino.toString()
      })
    }
    await expect(assertBrc38ProfilePhysicalIdentity(directory, original, true)).resolves.toBeUndefined()
  })
  test.each(['directory', 'owner', 'catalog', 'wallet'] as const)(
    'requires the original %s identity rather than a matching filename',
    async key => {
      const original = await captureBrc38ProfilePhysicalIdentity(directory, true),
        file = original[key]!
      const different = {
        ...original,
        [key]: { ...file, inode: (BigInt(file.inode) + 1n).toString() }
      }
      await expect(assertBrc38ProfilePhysicalIdentity(directory, different, true)).rejects.toThrow(
        'original physical identity differs'
      )
      await expect(assertBrc38ProfilePhysicalIdentity(directory, original, true)).resolves.toBeUndefined()
    }
  )
  test('incomplete enrollment does not claim a wallet binding, while provider verification requires it', async () => {
    const receiving = await captureBrc38ProfilePhysicalIdentity(directory)
    expect(receiving.wallet).toBeUndefined()
    expect(validBrc38ProfilePhysicalIdentity(receiving, false)).toBe(true)
    expect(validBrc38ProfilePhysicalIdentity(receiving, true)).toBe(false)
    await expect(assertBrc38ProfilePhysicalIdentity(directory, receiving, false)).resolves.toBeUndefined()
    await expect(assertBrc38ProfilePhysicalIdentity(directory, receiving, true)).rejects.toThrow(
      'physical binding is incomplete'
    )
  })
  test('a granted retirement can retain the same directory identity across its rename and partial physical removal', async () => {
    const original = await captureBrc38ProfilePhysicalIdentity(directory, true),
      retired = directory + '.retired'
    await rename(directory, retired)
    directory = retired
    await expect(assertBrc38RetiringProfilePhysicalIdentity(directory, original)).resolves.toBeUndefined()
    await rm(join(directory, 'wallet.sqlite'))
    await rm(join(directory, 'profile.sqlite'))
    await expect(assertBrc38RetiringProfilePhysicalIdentity(directory, original)).resolves.toBeUndefined()
    await expect(assertBrc38ProfilePhysicalIdentity(directory, original, true)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await rm(directory, { recursive: true })
    await expect(assertBrc38RetiringProfilePhysicalIdentity(directory, original)).resolves.toBeUndefined()
  })
  test('private modes remain mandatory even when device and inode are unchanged', async () => {
    const original = await captureBrc38ProfilePhysicalIdentity(directory, true)
    await chmod(join(directory, 'wallet.sqlite'), 0o400)
    const actual = await lstat(join(directory, 'wallet.sqlite'), { bigint: true })
    expect({ device: actual.dev.toString(), inode: actual.ino.toString() }).toEqual(original.wallet)
    expect(actual.mode & 0o777n).toBe(0o400n)
    await expect(assertBrc38ProfilePhysicalIdentity(directory, original, true)).rejects.toThrow(
      'Actual Unix private ownership or mode differs'
    )
    await expect(assertBrc38RetiringProfilePhysicalIdentity(directory, original)).rejects.toThrow(
      'Actual Unix private ownership or mode differs'
    )
  })
})
