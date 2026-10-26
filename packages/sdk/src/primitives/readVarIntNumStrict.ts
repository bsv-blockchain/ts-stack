import BigNumber from './BigNumber.js'

interface CompactSizeReader {
  readUInt8(): number
  readUInt16LE(): number
  readUInt32LE(): number
  readUInt64LEBn(): BigNumber
}

const UINT32_MAX = new BigNumber(0xffffffff)
const UINT64_MAX = new BigNumber(2).pow(new BigNumber(64)).sub(new BigNumber(1))
const MAX_SAFE_INTEGER = new BigNumber(Number.MAX_SAFE_INTEGER)

/** Shared canonical CompactSize decoding for both binary reader implementations. */
export default function readVarIntNumStrict(
  reader: CompactSizeReader,
  signed: boolean = true
): number {
  const first = reader.readUInt8()
  if (first < 0xfd) return first
  if (first === 0xfd) {
    const value = reader.readUInt16LE()
    if (value < 0xfd) throw new Error('non-canonical varInt')
    return value
  }
  if (first === 0xfe) {
    const value = reader.readUInt32LE()
    if (value <= 0xffff) throw new Error('non-canonical varInt')
    return value
  }
  const value = reader.readUInt64LEBn()
  if (value.lte(UINT32_MAX)) throw new Error('non-canonical varInt')
  if (signed && value.eq(UINT64_MAX)) return -1
  if (value.gt(MAX_SAFE_INTEGER)) {
    throw new Error('number too large to retain precision - use readVarIntBn')
  }
  return value.toNumber()
}
