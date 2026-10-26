import { Reader } from '../utils.js'
import { ReaderUint8Array } from '../ReaderUint8Array.js'

type BinaryReader = Reader | ReaderUint8Array
type ReaderFactory = (bytes?: number[], position?: number) => BinaryReader

const readers: Array<[string, ReaderFactory]> = [
  ['Reader', (bytes = [], position = 0) => new Reader(bytes, position)],
  [
    'ReaderUint8Array',
    (bytes = [], position = 0) => new ReaderUint8Array(bytes, position)
  ]
]

describe.each(readers)('%s untrusted-input bounds', (_name, createReader) => {
  it.each([-1, 2, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid initial position: %s',
    position => {
      expect(() => createReader([0], position)).toThrow(RangeError)
    }
  )

  it('reads the remaining bytes without advancing past EOF', () => {
    const reader = createReader([1, 2, 3])
    expect(Array.from(reader.read(1))).toEqual([1])
    expect(Array.from(reader.read())).toEqual([2, 3])
    expect(reader.pos).toBe(3)
    expect(reader.eof()).toBe(true)
  })

  it.each([
    ['read', (reader: BinaryReader) => reader.read(2)],
    ['readReverse', (reader: BinaryReader) => reader.readReverse(2)],
    ['readUInt8', (reader: BinaryReader) => reader.readUInt8()],
    ['readInt8', (reader: BinaryReader) => reader.readInt8()],
    ['readUInt16BE', (reader: BinaryReader) => reader.readUInt16BE()],
    ['readInt16BE', (reader: BinaryReader) => reader.readInt16BE()],
    ['readUInt16LE', (reader: BinaryReader) => reader.readUInt16LE()],
    ['readInt16LE', (reader: BinaryReader) => reader.readInt16LE()],
    ['readUInt32BE', (reader: BinaryReader) => reader.readUInt32BE()],
    ['readInt32BE', (reader: BinaryReader) => reader.readInt32BE()],
    ['readUInt32LE', (reader: BinaryReader) => reader.readUInt32LE()],
    ['readInt32LE', (reader: BinaryReader) => reader.readInt32LE()],
    ['readUInt64BEBn', (reader: BinaryReader) => reader.readUInt64BEBn()],
    ['readUInt64LEBn', (reader: BinaryReader) => reader.readUInt64LEBn()],
    ['readInt64LEBn', (reader: BinaryReader) => reader.readInt64LEBn()]
  ])('rejects a truncated %s operation', (_method, operation) => {
    expect(() => operation(createReader())).toThrow(RangeError)
  })

  it('rejects reads after a caller mutates the public cursor out of range', () => {
    const reader = createReader([0])
    reader.pos = -1
    expect(() => reader.readUInt8()).toThrow(RangeError)
    reader.pos = 2
    expect(() => reader.read(0)).toThrow(RangeError)
  })

  it.each([[[0xfd]], [[0xfe, 1]], [[0xff, 1, 2, 3]]])(
    'rejects a truncated CompactSize value: %j',
    bytes => {
      expect(() => createReader(bytes).readVarInt()).toThrow(RangeError)
      expect(() => createReader(bytes).readVarIntNumStrict(false)).toThrow(RangeError)
    }
  )

  it.each([
    [[0xfd, 0xfc, 0x00]],
    [[0xfe, 0xff, 0xff, 0x00, 0x00]],
    [[0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]]
  ])('rejects non-canonical CompactSize encoding %j', bytes => {
    expect(() => createReader(bytes).readVarIntNumStrict(false)).toThrow('non-canonical varInt')
  })

  it('accepts canonical boundary values and rejects imprecise values', () => {
    expect(createReader([0xfc]).readVarIntNumStrict(false)).toBe(0xfc)
    expect(createReader([0xfd, 0xfd, 0]).readVarIntNumStrict(false)).toBe(0xfd)
    expect(createReader([0xfe, 0, 0, 1, 0]).readVarIntNumStrict(false)).toBe(0x10000)
    expect(
      createReader([0xff, 0, 0, 0, 0, 1, 0, 0, 0]).readVarIntNumStrict(false)
    ).toBe(0x100000000)
    expect(() =>
      createReader([0xff, 0, 0, 0, 0, 0, 0, 0x20, 0]).readVarIntNumStrict(false)
    ).toThrow('number too large to retain precision')
    expect(createReader([0xff, ...Array(8).fill(0xff)]).readVarIntNumStrict()).toBe(-1)
    expect(() =>
      createReader([0xff, ...Array(8).fill(0xff)]).readVarIntNumStrict(false)
    ).toThrow('number too large to retain precision')
  })
})
