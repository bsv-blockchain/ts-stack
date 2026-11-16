import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { copyBrc38OwnedDatabase, hashBrc38PublishedDatabase } from './Brc38PrivatePublicationCopyNode'
import { captureBrc38ProfilePhysicalIdentity } from './Brc38ProfilePhysicalIdentityNode'

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
const fill = fc.integer({ min: 0, max: 255 })
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'brc38-publication-copy-property-'))
  await chmod(directory, 0o700)
  if (process.env.TMPDIR === '/work/fixtures')
    await appendFile('/work/validation/fixture-record.jsonl', JSON.stringify({ path: directory }) + '\n')
})
afterEach(async () => {
  await rm(directory, { recursive: true })
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
const source = () => join(directory, 'wallet.sqlite')
const destination = () => join(directory, 'copied.sqlite')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function withSource<T>(bytes: Buffer, work: () => Promise<T>): Promise<T> {
  await writeFile(source(), bytes, { flag: 'wx', mode: 0o600 })
  try {
    return await work()
  } finally {
    expect((await readFile(source())).equals(bytes)).toBe(true)
    await rm(source())
    await rm(destination(), { force: true })
  }
}
// Ordinary source-owned file-copy unit. The bytes are synthetic file data;
// this suite does not create a valid wallet, grant native ownership, publish a
// profile, activate it, or establish complete restore/process-loss behavior.
test('generated source bytes copy and hash exactly across fixed-buffer boundaries', async () => {
  await fc.assert(
    fc.asyncProperty(fill, fc.constantFrom(4096, 262144, 262145, 524289), async (value, size) => {
      const bytes = Buffer.alloc(size, value)
      await withSource(bytes, async () => {
        let calls = 0
        const receipt = await copyBrc38OwnedDatabase(source(), destination(), size, Date.now() + 10000, () => {
          calls++
        })
        expect(receipt).toEqual({ bytes: size, sha256: digest(bytes) })
        expect(Object.isFrozen(receipt)).toBe(true)
        // Ownership is checked before opening the source, before target
        // creation, before each chunk, and before returning the receipt.
        expect(calls).toBe(3 + Math.ceil(size / 262144))
        expect((await readFile(destination())).equals(bytes)).toBe(true)
        expect((await stat(destination())).mode & 0o777).toBe(0o600)
        expect(await hashBrc38PublishedDatabase(destination(), size)).toBe(digest(bytes))
      })
    }),
    controls
  )
}, 30000)
test('generated physical byte caps refuse before creating a destination and exclusive destinations retain their bytes', async () => {
  await fc.assert(
    fc.asyncProperty(fill, fc.integer({ min: 0, max: 2048 }), async (value, extra) => {
      const bytes = Buffer.alloc(4096 + extra, value)
      await withSource(bytes, async () => {
        await expect(
          copyBrc38OwnedDatabase(source(), destination(), bytes.length - 1, Date.now() + 10000, () => {})
        ).rejects.toThrow('physical policy')
        await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(hashBrc38PublishedDatabase(source(), bytes.length - 1)).rejects.toThrow('physical policy')
        const existing = Buffer.from([value, value ^ 255])
        await writeFile(destination(), existing, { flag: 'wx', mode: 0o600 })
        await expect(
          copyBrc38OwnedDatabase(source(), destination(), bytes.length, Date.now() + 10000, () => {})
        ).rejects.toMatchObject({ code: 'EEXIST' })
        expect(await readFile(destination())).toEqual(existing)
      })
    }),
    controls
  )
}, 30000)
test('generated original expiry and cancellation refuse before source ownership or destination creation', async () => {
  await fc.assert(
    fc.asyncProperty(fill, fc.boolean(), async (value, cancelled) => {
      await withSource(Buffer.alloc(4096, value), async () => {
        const controller = new AbortController(),
          reason = new Error('copy cancelled ' + value)
        let calls = 0
        if (cancelled) controller.abort(reason)
        const pending = copyBrc38OwnedDatabase(
          source(),
          destination(),
          4096,
          cancelled ? Date.now() + 10000 : Date.now() - 1,
          () => {
            calls++
          },
          controller.signal
        )
        if (cancelled) await expect(pending).rejects.toBe(reason)
        else await expect(pending).rejects.toThrow('deadline expired')
        expect(calls).toBe(0)
        await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
      })
    }),
    controls
  )
}, 30000)
test('generated current ownership rejection retains the cause and never returns a successful copy receipt', async () => {
  await fc.assert(
    fc.asyncProperty(fill, fc.integer({ min: 1, max: 5 }), async (value, refuseAt) => {
      const bytes = Buffer.alloc(262145, value)
      await withSource(bytes, async () => {
        const reason = new Error('owned copy rejected ' + value),
          seen: number[] = []
        await expect(
          copyBrc38OwnedDatabase(source(), destination(), bytes.length, Date.now() + 10000, () => {
            seen.push(seen.length + 1)
            if (seen.length === refuseAt) throw reason
          })
        ).rejects.toBe(reason)
        expect(seen).toHaveLength(refuseAt)
        if (refuseAt <= 2) await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
        else {
          const copied = await readFile(destination())
          expect(copied.length).toBe(refuseAt === 3 ? 0 : refuseAt === 4 ? 262144 : bytes.length)
          expect(copied.equals(bytes.subarray(0, copied.length))).toBe(true)
        }
      })
    }),
    controls
  )
}, 30000)
test('generated exact descriptor receipts hash the owned file and mismatching current device or inode refuses', async () => {
  await fc.assert(
    fc.asyncProperty(fill, fc.integer({ min: 1, max: 1000000 }), fc.boolean(), async (value, delta, device) => {
      await withSource(Buffer.alloc(4096, value), async () => {
        for (const name of ['owner.sqlite', 'profile.sqlite'])
          await writeFile(join(directory, name), Buffer.alloc(4096, value), {
            flag: 'wx',
            mode: 0o600
          })
        try {
          const physical = await captureBrc38ProfilePhysicalIdentity(directory, true)
          if (physical.wallet === undefined) throw new Error('Actual wallet descriptor receipt required')
          expect(await hashBrc38PublishedDatabase(source(), 4096, physical.wallet)).toBe(
            digest(Buffer.alloc(4096, value))
          )
          const field = device ? 'device' : 'inode',
            mismatch = {
              ...physical.wallet,
              [field]: (BigInt(physical.wallet[field]) + BigInt(delta)).toString()
            }
          await expect(hashBrc38PublishedDatabase(source(), 4096, mismatch)).rejects.toThrow(
            'opened descriptor identity differs'
          )
          expect(await hashBrc38PublishedDatabase(source(), 4096, physical.wallet)).toBe(
            digest(Buffer.alloc(4096, value))
          )
        } finally {
          await rm(join(directory, 'owner.sqlite'))
          await rm(join(directory, 'profile.sqlite'))
        }
      })
    }),
    controls
  )
}, 30000)
