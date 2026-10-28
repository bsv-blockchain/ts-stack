import { Reader } from '../utils.js'
import { ReaderUint8Array } from '../ReaderUint8Array.js'
import { readVarIntBnStrict } from '../readVarIntNumStrict.js'

const readers: Array<[string, (bytes: number[]) => Reader | ReaderUint8Array]> = [
  ['Reader', bytes => new Reader(bytes)],
  ['ReaderUint8Array', bytes => new ReaderUint8Array(bytes)]
]

const le = (value: bigint, width: number): number[] =>
  Array.from({ length: width }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn))

describe.each(readers)('readVarIntBnStrict over %s', (_name, createReader) => {
  const read = (bytes: number[]): string => readVarIntBnStrict(createReader(bytes)).toString(10)

  it('reads the canonical value at each CompactSize width and consumes it exactly', () => {
    const cases: Array<[number[], bigint]> = [
      [[0x00], 0n],
      [[0xfc], 0xfcn],
      [[0xfd, ...le(0xfdn, 2)], 0xfdn],
      [[0xfd, ...le(0xffffn, 2)], 0xffffn],
      [[0xfe, ...le(0x10000n, 4)], 0x10000n],
      [[0xfe, ...le(0xffffffffn, 4)], 0xffffffffn],
      [[0xff, ...le(0x100000000n, 8)], 0x100000000n],
      [[0xff, ...le(2n ** 64n - 1n, 8)], 2n ** 64n - 1n]
    ]
    for (const [bytes, value] of cases) {
      const reader = createReader([...bytes, 0xaa])
      expect(readVarIntBnStrict(reader).toString(10)).toBe(value.toString())
      expect(reader.readUInt8()).toBe(0xaa)
    }
  })

  it('rejects a value that fits a shorter width', () => {
    for (const bytes of [
      [0xfd, ...le(0n, 2)],
      [0xfd, ...le(0xfcn, 2)],
      [0xfe, ...le(0n, 4)],
      [0xfe, ...le(0xffffn, 4)],
      [0xff, ...le(0n, 8)],
      [0xff, ...le(0xffffffffn, 8)]
    ]) {
      expect(() => read(bytes)).toThrow('non-canonical varInt')
    }
  })

  it('rejects truncation at each width', () => {
    for (const bytes of [
      [],
      [0xfd],
      [0xfd, 0xfd],
      [0xfe, 0x00, 0x00, 0x01],
      [0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]
    ]) {
      expect(() => read(bytes)).toThrow()
    }
  })
})
