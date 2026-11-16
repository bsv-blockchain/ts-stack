import fc from 'fast-check'
import { brc38StagingBinding, type Brc38StagingBinding } from './Brc38StagingBinding'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})

const limits: KnexBrc38StagingLimits = {
  maximumRows: 1000,
  maximumLogicalBytes: 1048576,
  maximumPhysicalBytes: 2097152,
  maximumRowBytes: 65536,
  maximumRowAllocationBytes: 131072,
  expiresAt: 2000000000000
}
const selected = fc.record({
  archiveSha256: fc.uint8Array({ minLength: 32, maxLength: 32 }).map(bytes => Buffer.from(bytes).toString('hex')),
  identityKey: fc.string({ minLength: 1, maxLength: 64 }),
  chain: fc.constantFrom<'main' | 'test'>('main', 'test'),
  sourceStorageIdentityKey: fc.string({ minLength: 1, maxLength: 64 }),
  targetStorageIdentityKey: fc.string({ minLength: 1, maxLength: 64 }),
  targetGeneration: fc.integer({ min: 0, max: 1000000 })
})

describe('private staging resume binding preserves each independent identity', () => {
  test('every identity and destination epoch changes resume identity without mutating the caller', () => {
    fc.assert(
      fc.property(selected, value => {
        const input = { ...value }
        const result = brc38StagingBinding(input, { ...limits })
        expect(input).toEqual(value)
        expect(result.binding).toEqual(value)
        expect(result.binding).not.toBe(input)
        expect(Object.isFrozen(result)).toBe(true)
        expect(Object.isFrozen(result.binding)).toBe(true)
        expect(JSON.parse(result.bindingJson)).toEqual(value)
        expect(brc38StagingBinding({ ...value }, { ...limits }).digest).toBe(result.digest)

        const variants: Brc38StagingBinding[] = [
          {
            ...value,
            archiveSha256: (value.archiveSha256[0] === '0' ? '1' : '0') + value.archiveSha256.slice(1)
          },
          { ...value, identityKey: value.identityKey + 'x' },
          { ...value, chain: value.chain === 'main' ? 'test' : 'main' },
          { ...value, sourceStorageIdentityKey: value.sourceStorageIdentityKey + 'x' },
          { ...value, targetStorageIdentityKey: value.targetStorageIdentityKey + 'x' },
          { ...value, targetGeneration: value.targetGeneration + 1 }
        ]
        for (const changed of variants) {
          expect(brc38StagingBinding(changed, { ...limits }).digest).not.toBe(result.digest)
        }
        for (const field of Object.keys(limits) as Array<keyof KnexBrc38StagingLimits>) {
          expect(brc38StagingBinding(value, { ...limits, [field]: limits[field] + 1 }).digest).not.toBe(result.digest)
        }
        input.identityKey += 'changed-after-binding'
        expect(result.binding.identityKey).toBe(value.identityKey)
      }),
      {
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true,
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
      }
    )
  })

  test('invalid profile, digest, chain and generation refuse without modifying the supplied record', () => {
    fc.assert(
      fc.property(selected, fc.constantFrom(-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY), (value, generation) => {
        const invalid = { ...value, targetGeneration: generation }
        expect(() => brc38StagingBinding(invalid, limits)).toThrow(RangeError)
        expect(Object.is(invalid.targetGeneration, generation)).toBe(true)
        expect(() => brc38StagingBinding({ ...value, archiveSha256: value.archiveSha256.slice(1) }, limits)).toThrow(
          TypeError
        )
        for (const field of ['identityKey', 'sourceStorageIdentityKey', 'targetStorageIdentityKey'] as const) {
          expect(() => brc38StagingBinding({ ...value, [field]: '' }, limits)).toThrow(TypeError)
          expect(() => brc38StagingBinding({ ...value, [field]: 'a'.repeat(257) }, limits)).toThrow(TypeError)
        }
        expect(() => brc38StagingBinding({ ...value, chain: 'other' as 'main' }, limits)).toThrow(TypeError)
      }),
      {
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true,
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
      }
    )
  })
})
