import fc from 'fast-check'
import { canonicalPortableChunks } from './CanonicalPortableChunks'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

type Value = string | number | boolean | Value[] | { [key: string]: Value }
function reference(value: Value): string {
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(reference).join(',') + ']'
  return (
    '{' +
    Object.keys(value)
      .sort((first, second) => Number(first > second) - Number(first < second))
      .map(key => JSON.stringify(key) + ':' + reference(value[key]))
      .join(',') +
    '}'
  )
}
const scalar = fc.oneof(
  fc.boolean(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc
    .array(fc.integer({ min: 0, max: 0x10f7ff }), { maxLength: 24 })
    .map(points => String.fromCodePoint(...points.map(point => (point < 0xd800 ? point : point + 0x800))))
)
const values = fc.letrec<{ value: Value }>(tie => ({
  value: fc.oneof(
    { depthSize: 'small' },
    scalar,
    fc.array(tie('value'), { maxLength: 6 }),
    fc.dictionary(fc.string({ maxLength: 8 }), tie('value'), { maxKeys: 6 })
  )
})).value

test('generated JSON values preserve exact canonical bytes and per-chunk bounds', () => {
  fc.assert(
    fc.property(values, fc.integer({ min: 64, max: 1024 }), (value, maximumChunkBytes) => {
      const chunks = [...canonicalPortableChunks(value, { maximumValueBytes: 16777216, maximumChunkBytes })]
      expect(chunks.every(chunk => chunk.byteLength > 0 && chunk.byteLength <= maximumChunkBytes)).toBe(true)
      expect(Buffer.concat(chunks).toString('utf8')).toBe(reference(value))
    }),
    {
      numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? 300)),
      seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
      ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
}, 180000)
