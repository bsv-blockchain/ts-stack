import fc from 'fast-check'
import { chmod, link, lstat, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertBrc38ProfileFileDescriptor,
  assertBrc38ProfilePhysicalIdentity,
  assertBrc38RetiringProfilePhysicalIdentity,
  captureBrc38ProfilePhysicalIdentity,
  validBrc38ProfilePhysicalIdentity
} from './Brc38ProfilePhysicalIdentityNode'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
const componentNames = {
  directory: '',
  owner: 'owner.sqlite',
  catalog: 'profile.sqlite',
  wallet: 'wallet.sqlite'
} as const
const fileKeys = ['owner', 'catalog', 'wallet'] as const
const integerIdentity = fc.bigInt({ min: 0n, max: 10n ** 40n - 1n }).map(String)
const fileIdentity = fc.record({ device: integerIdentity, inode: integerIdentity })

describe('private profile identities bind exact owned filesystem objects', () => {
  test('generated full-width decimal identities preserve the optional wallet contract', () => {
    fc.assert(
      fc.property(
        fc.record({
          directory: fileIdentity,
          owner: fileIdentity,
          catalog: fileIdentity,
          wallet: fileIdentity
        }),
        fc.boolean(),
        fc.constantFrom('directory', 'owner', 'catalog', 'wallet'),
        fc.constantFrom('device', 'inode'),
        fc.constantFrom('leading-zero', 'negative', 'fraction', 'overflow', 'absent'),
        (complete, walletRequired, component, field, defect) => {
          expect(validBrc38ProfilePhysicalIdentity(complete, walletRequired)).toBe(true)
          const { wallet: omitted, ...receiving } = complete
          expect(omitted).toBeDefined()
          expect(validBrc38ProfilePhysicalIdentity(receiving, walletRequired)).toBe(!walletRequired)
          const original = complete[component][field]
          // Round trips use the integer representation as an independent oracle;
          // decimal width is retained even beyond JavaScript's safe-number range.
          expect(BigInt(original).toString()).toBe(original)
          const malformed =
            defect === 'leading-zero'
              ? '0' + original
              : defect === 'negative'
                ? '-' + original
                : defect === 'fraction'
                  ? original + '.0'
                  : defect === 'overflow'
                    ? (10n ** 40n + BigInt(original)).toString()
                    : undefined
          expect(
            validBrc38ProfilePhysicalIdentity(
              {
                ...complete,
                [component]: { ...complete[component], [field]: malformed }
              },
              walletRequired
            )
          ).toBe(false)
        }
      ),
      controls
    )
  }, 30000)

  test('generated object changes are rejected and granted retirement tolerates only owned removals', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...fileKeys),
        fc.constantFrom('mode', 'hard-link', 'replacement'),
        fc.integer({ min: 0, max: fileKeys.length }),
        fc.bigInt({ min: 1n, max: 4096n }),
        async (selected, defect, removedCount, delta) => {
          const directory = await mkdtemp(join(tmpdir(), 'brc38-property-physical-')),
            retired = directory + '.retired'
          try {
            await chmod(directory, 0o700)
            for (const key of fileKeys) {
              const created = await open(join(directory, componentNames[key]), 'wx', 0o600)
              await created.close()
            }
            const original = await captureBrc38ProfilePhysicalIdentity(directory, true)
            for (const key of ['directory', ...fileKeys] as const) {
              const stat = await lstat(join(directory, componentNames[key]), { bigint: true })
              expect(original[key]).toEqual({
                device: stat.dev.toString(),
                inode: stat.ino.toString()
              })
              expect(Object.isFrozen(original[key])).toBe(true)
            }
            expect(Object.isFrozen(original)).toBe(true)
            await assertBrc38ProfilePhysicalIdentity(directory, original, true)
            const bound = original[selected]!,
              filename = join(directory, componentNames[selected]),
              changed = { ...bound, inode: (BigInt(bound.inode) + delta).toString() },
              file = await open(filename, 'r')
            try {
              await assertBrc38ProfileFileDescriptor(file, bound)
              await expect(assertBrc38ProfileFileDescriptor(file, changed)).rejects.toThrow(
                'opened descriptor identity differs'
              )
              await expect(
                assertBrc38ProfilePhysicalIdentity(directory, { ...original, [selected]: changed }, true)
              ).rejects.toThrow('original physical identity differs')
              if (defect === 'mode') {
                await chmod(filename, 0o400)
                expect((await file.stat()).mode & 0o777).toBe(0o400)
                await expect(assertBrc38ProfileFileDescriptor(file, bound)).rejects.toThrow(
                  'Actual Unix private ownership or mode differs'
                )
                await expect(assertBrc38ProfilePhysicalIdentity(directory, original, true)).rejects.toThrow(
                  'Actual Unix private ownership or mode differs'
                )
                await chmod(filename, 0o600)
              } else if (defect === 'hard-link') {
                const alias = filename + '.alias'
                await link(filename, alias)
                expect((await file.stat()).nlink).toBe(2)
                await expect(assertBrc38ProfileFileDescriptor(file, bound)).rejects.toThrow(
                  'Actual private descriptor type or link count differs'
                )
                await expect(assertBrc38ProfilePhysicalIdentity(directory, original, true)).rejects.toThrow(
                  'Actual private file type or link count differs'
                )
                await rm(alias)
              } else {
                const saved = filename + '.original',
                  replacementPath = filename + '.replacement',
                  replacement = await open(replacementPath, 'wx', 0o600)
                try {
                  await rename(filename, saved)
                  await rename(replacementPath, filename)
                  await expect(assertBrc38ProfileFileDescriptor(replacement, bound)).rejects.toThrow(
                    'opened descriptor identity differs'
                  )
                  await expect(assertBrc38ProfilePhysicalIdentity(directory, original, true)).rejects.toThrow(
                    'original physical identity differs'
                  )
                  await assertBrc38ProfileFileDescriptor(file, bound)
                } finally {
                  await replacement.close()
                }
                await rm(filename)
                await rename(saved, filename)
              }
              await assertBrc38ProfileFileDescriptor(file, bound)
            } finally {
              await file.close()
            }
            await assertBrc38ProfilePhysicalIdentity(directory, original, true)
            await rename(directory, retired)
            for (const key of fileKeys.slice(0, removedCount)) await rm(join(retired, componentNames[key]))
            await assertBrc38RetiringProfilePhysicalIdentity(retired, original)
            if (removedCount > 0)
              await expect(assertBrc38ProfilePhysicalIdentity(retired, original, true)).rejects.toMatchObject({
                code: 'ENOENT'
              })
            await rm(retired, { recursive: true })
            await assertBrc38RetiringProfilePhysicalIdentity(retired, original)
          } finally {
            await rm(directory, { recursive: true, force: true })
            await rm(retired, { recursive: true, force: true })
          }
        }
      ),
      controls
    )
  }, 30000)
})
