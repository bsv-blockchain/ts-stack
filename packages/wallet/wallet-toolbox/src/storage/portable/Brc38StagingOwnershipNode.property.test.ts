import fc from 'fast-check'
import { constants, type Stats } from 'node:fs'
import { appendFile, chmod, lstat, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { types } from 'node:util'
import { Brc38StagingOwnershipNode } from './Brc38StagingOwnershipNode'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
const digest = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map(values => values.map(value => value.toString(16)).join(''))
const otherBinding = (value: string) => (value[0] === '0' ? '1' : '0') + value.slice(1)

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-property-ownership-'))
  await chmod(directory, 0o700)
  if (process.env.TMPDIR === '/work/fixtures')
    await appendFile('/work/validation/fixture-record.jsonl', JSON.stringify({ path: directory }) + '\n')
  const owners: Brc38StagingOwnershipNode[] = []
  async function retain(promise: Promise<Brc38StagingOwnershipNode>) {
    const owner = await promise
    owners.push(owner)
    return owner
  }
  async function refuse(promise: Promise<Brc38StagingOwnershipNode>): Promise<unknown> {
    try {
      // Register even an unexpectedly successful claim so assertion failure
      // cannot strand a real connection or pinned physical writer lock.
      await retain(promise)
    } catch (cause) {
      return cause
    }
    throw new Error('A refused ownership operation unexpectedly acquired its lock')
  }
  return {
    directory,
    retain,
    refuse,
    close: async () => {
      for (const owner of owners) await owner.release()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

async function readOriginalOwner(path: string, identity: Stats): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const actual = await file.stat()
    expect(actual.isFile()).toBe(true)
    expect(actual.nlink).toBe(1)
    expect([actual.dev, actual.ino]).toEqual([identity.dev, identity.ino])
    expect(actual.mode & 0o777).toBe(0o600)
    expect(actual.size).toBeLessThanOrEqual(16384)
    return await file.readFile()
  } finally {
    await file.close()
  }
}

describe('actual pinned private staging ownership lifecycle', () => {
  test('generated bindings and clean handoffs preserve the original physical owner and fixed lease', async () => {
    await fc.assert(
      fc.asyncProperty(digest, fc.integer({ min: 1, max: 3 }), async (binding, handoffs) => {
        const owned = await fixture()
        try {
          const expiry = Date.now() + 60000
          let current = await owned.retain(Brc38StagingOwnershipNode.create(owned.directory, binding, expiry))
          const path = join(owned.directory, 'brc38-owner.sqlite')
          const identity = await lstat(path)
          expect(identity.mode & 0o777).toBe(0o600)
          expect(identity.size).toBeLessThanOrEqual(16384)
          for (let index = 0; index < handoffs; index++) {
            expect(current.directory).toBe(owned.directory)
            expect(current.binding).toBe(binding)
            expect(current.expiresAt).toBe(expiry)
            expect(current.purpose).toBe('resume')
            current.assertLive()
            const contender = await owned.refuse(Brc38StagingOwnershipNode.claimExisting(owned.directory, binding))
            // The native driver can construct its Error in a different Jest realm.
            expect(types.isNativeError(contender)).toBe(true)
            expect(contender).toMatchObject({ code: 'SQLITE_BUSY' })
            expect((contender as Error).message).toMatch(/locked|busy/i)
            current.assertLive()
            const old = current
            await old.release()
            await old.release()
            expect(() => old.assertLive()).toThrow('unavailable')
            const bytes = await readOriginalOwner(path, identity)
            const mismatch = await owned.refuse(
              Brc38StagingOwnershipNode.claimExisting(owned.directory, otherBinding(binding))
            )
            expect(mismatch).toBeInstanceOf(Error)
            expect((mismatch as Error).message).toContain('binding')
            expect(await readOriginalOwner(path, identity)).toEqual(bytes)
            const unchanged = await lstat(path)
            expect([unchanged.dev, unchanged.ino]).toEqual([identity.dev, identity.ino])
            expect(unchanged.mode & 0o777).toBe(0o600)
            current = await owned.retain(Brc38StagingOwnershipNode.claimExisting(owned.directory, binding))
          }
          await current.release()
          expect(() => current.assertLive()).toThrow('unavailable')
          expect(await readdir(owned.directory)).toEqual(['brc38-owner.sqlite'])
        } finally {
          await owned.close()
        }
      }),
      controls
    )
  }, 30000)

  test('generated invalid caller parameters, missing files and directory permissions refuse before ownership creation', async () => {
    await fc.assert(
      fc.asyncProperty(
        digest,
        fc.constantFrom('digest', 'expired', 'fractional', 'overlong', 'public', 'missing', 'purpose'),
        async (binding, kind) => {
          const owned = await fixture()
          try {
            const now = Date.now()
            let cause: unknown
            if (kind === 'missing') {
              cause = await owned.refuse(Brc38StagingOwnershipNode.claimExisting(owned.directory, binding))
              expect(cause).toMatchObject({ code: 'ENOENT' })
            } else if (kind === 'purpose') {
              cause = await owned.refuse(
                Reflect.apply(Brc38StagingOwnershipNode.claimExisting, Brc38StagingOwnershipNode, [
                  owned.directory,
                  binding,
                  'future-profile'
                ])
              )
              expect(cause).toBeInstanceOf(TypeError)
            } else {
              if (kind === 'public') await chmod(owned.directory, 0o755)
              const selectedDigest = kind === 'digest' ? binding.toUpperCase() + 'x' : binding
              const expiry =
                kind === 'expired'
                  ? now
                  : kind === 'fractional'
                    ? now + 60000.5
                    : kind === 'overlong'
                      ? now + 172800000
                      : now + 60000
              cause = await owned.refuse(Brc38StagingOwnershipNode.create(owned.directory, selectedDigest, expiry))
              expect(cause).toBeInstanceOf(Error)
              if (kind === 'digest') expect(cause).toBeInstanceOf(TypeError)
              if (['expired', 'fractional', 'overlong'].includes(kind)) expect(cause).toBeInstanceOf(RangeError)
              if (kind === 'public') {
                expect((await lstat(owned.directory)).mode & 0o777).toBe(0o755)
                expect((cause as Error).message).toBe('Actual Unix private ownership or mode differs')
              }
            }
            expect(await readdir(owned.directory)).toEqual([])
          } finally {
            await owned.close()
          }
        }
      ),
      controls
    )
  }, 30000)

  test('generated expired claims cannot renew a fixed original deadline or make a cleanup owner writable', async () => {
    const owned = await fixture()
    try {
      const binding = 'a'.repeat(64)
      const expiry = Date.now() + 5000
      const initial = await owned.retain(Brc38StagingOwnershipNode.create(owned.directory, binding, expiry))
      await initial.release()
      // This is the actual clock and original fixed lease, never a mocked clock
      // or a rewritten durable row. The complete root-catalog cleanup grant is
      // a separate lifecycle contract, not inferred from this standalone API.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry - Date.now() + 10)))
      expect(Date.now()).toBeGreaterThanOrEqual(expiry)
      const path = join(owned.directory, 'brc38-owner.sqlite')
      const bytes = await readFile(path)
      await fc.assert(
        fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 3 }), async (wrongBinding, releases) => {
          const requested = wrongBinding ? otherBinding(binding) : binding
          const cause = await owned.refuse(Brc38StagingOwnershipNode.claimExisting(owned.directory, requested))
          expect(cause).toBeInstanceOf(Error)
          expect((cause as Error).message).toContain(wrongBinding ? 'binding' : 'expired')
          // An actual existing owner row may be acquired for disposal only;
          // it never supplies live stage authority and retains its original
          // persisted deadline. No incomplete-creation grant is fabricated.
          const cleanup = await owned.retain(
            Brc38StagingOwnershipNode.claimExisting(owned.directory, binding, 'cleanup')
          )
          expect(cleanup.binding).toBe(binding)
          expect(cleanup.expiresAt).toBe(expiry)
          expect(cleanup.purpose).toBe('cleanup')
          expect(() => cleanup.assertLive()).toThrow('unavailable')
          const contender = await owned.refuse(Brc38StagingOwnershipNode.claimExisting(owned.directory, binding))
          expect((contender as Error).message).toMatch(/locked|busy/i)
          for (let count = 0; count < releases; count++) await cleanup.release()
          expect(() => cleanup.assertLive()).toThrow('unavailable')
          expect(await readFile(path)).toEqual(bytes)
        }),
        controls
      )
      expect(await readdir(owned.directory)).toEqual(['brc38-owner.sqlite'])
    } finally {
      await owned.close()
    }
  }, 30000)
})
