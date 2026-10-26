import { BigNumber } from '@bsv/sdk'
import type { BulkHeaderFileInfo } from '../BulkHeaderFile'
import {
  blockHash,
  convertBitsToTarget,
  convertBitsToWork,
  convertBufferToUint32,
  convertUint32ToBuffer,
  deserializeBaseBlockHeader,
  deserializeBaseBlockHeaders,
  deserializeBlockHeader,
  genesisBuffer,
  genesisHeader,
  serializeBaseBlockHeader,
  sha256HashOfBinaryFile,
  validateBufferOfHeaders,
  validateBulkFileData,
  validateHeaderDifficulty,
  validateHeaderFormat,
  workBNtoBuffer,
  writeUInt32LE
} from '../blockHeaderUtilities'

const ZERO_HASH = '00'.repeat(32)

function bulkInfo(overrides: Partial<BulkHeaderFileInfo> = {}): BulkHeaderFileInfo {
  return {
    chain: 'main',
    count: 1,
    firstHeight: 0,
    fileName: 'mainNet_0.headers',
    fileHash: '',
    prevHash: ZERO_HASH,
    lastHash: '',
    prevChainWork: ZERO_HASH,
    lastChainWork: '',
    data: Uint8Array.from(genesisBuffer('main')),
    ...overrides
  }
}

describe('block-header utility hostile boundaries', () => {
  test('rejects non-byte inputs, malformed windows, and byte coercion', () => {
    expect(() => deserializeBaseBlockHeader({} as never)).toThrow('byte array')
    expect(() =>
      deserializeBaseBlockHeader(
        Array(80)
          .fill(0)
          .map((value, index) => (index === 40 ? -1 : value))
      )
    ).toThrow('byte integers')
    expect(() => deserializeBaseBlockHeaders(new Uint8Array(80), -1)).toThrow('offset')
    expect(() => writeUInt32LE(1, {} as never, 0)).toThrow('writable byte array')
    expect(() => writeUInt32LE(1, new Uint8Array(4), 1)).toThrow('offset')
  })

  test('copies only own plain header data before serialization', () => {
    const header = genesisHeader('main')
    expect(() => serializeBaseBlockHeader(null as never)).toThrow('plain data object')
    expect(() => serializeBaseBlockHeader([] as never)).toThrow('plain data object')
    expect(() => serializeBaseBlockHeader(Object.create(header) as never)).toThrow('plain data object')
    const missing = { ...header } as Record<string, unknown>
    delete missing.nonce
    expect(() => serializeBaseBlockHeader(missing as never)).toThrow('own nonce data property')
    expect(() => serializeBaseBlockHeader(header, new Uint8Array(80) as never)).toThrow('buffer')
  })

  test('hashes bounded binary files and closes handles on every outcome', async () => {
    const data = Uint8Array.from([1, 2, 3, 4, 5])
    const close = jest.fn(async () => undefined)
    const file = {
      getLength: jest.fn(async () => data.length),
      read: jest.fn(async (length: number, offset: number) => data.slice(offset, offset + Math.min(length, 2))),
      close
    }
    const fs = { openReadableFile: jest.fn(async () => file) }

    await expect(sha256HashOfBinaryFile(fs as never, '/headers', 2)).resolves.toMatchObject({ length: 5 })
    expect(file.read).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(1)
    await expect(sha256HashOfBinaryFile(fs as never, '/headers', 0)).rejects.toThrow('bufferSize')

    file.getLength.mockResolvedValueOnce(8_000_001)
    await expect(sha256HashOfBinaryFile(fs as never, '/headers')).rejects.toThrow('file length')
    expect(close).toHaveBeenCalledTimes(2)

    file.getLength.mockResolvedValueOnce(1)
    file.read.mockResolvedValueOnce(new Uint8Array())
    await expect(sha256HashOfBinaryFile(fs as never, '/headers')).rejects.toThrow('invalid or incomplete chunk')
    expect(close).toHaveBeenCalledTimes(3)
  })

  test.each([
    ['non-object metadata', null],
    ['unsupported count', bulkInfo({ count: 0 })],
    ['negative height', bulkInfo({ firstHeight: -1 })],
    ['overflowing height range', bulkInfo({ firstHeight: 0x7fffffff, count: 2 })],
    ['unsupported chain', bulkInfo({ chain: 'invalid' as never })],
    ['path-bearing file name', bulkInfo({ fileName: '../headers' })],
    ['missing data', bulkInfo({ data: undefined })],
    ['non-byte data', bulkInfo({ data: [1] as never })],
    ['wrong data length', bulkInfo({ data: new Uint8Array(79) })]
  ])('rejects bulk files with %s', async (_name, info) => {
    await expect(validateBulkFileData(info as never, ZERO_HASH, ZERO_HASH)).rejects.toThrow()
  })

  test('rejects malformed previous hash and chain-work anchors', async () => {
    await expect(validateBulkFileData(bulkInfo(), '00', ZERO_HASH)).rejects.toThrow('prevHash')
    await expect(validateBulkFileData(bulkInfo(), ZERO_HASH, '00')).rejects.toThrow('prevChainWork')
  })

  test('rejects accessor-backed bulk metadata without invoking it', async () => {
    const getter = jest.fn(() => 1)
    const info = bulkInfo()
    Object.defineProperty(info, 'count', { enumerable: true, get: getter })
    await expect(validateBulkFileData(info, ZERO_HASH, ZERO_HASH)).rejects.toThrow('accessor-free')
    expect(getter).not.toHaveBeenCalled()
  })

  test('checks optional file hash, final hash, and chain-work declarations', async () => {
    await expect(validateBulkFileData(bulkInfo({ fileHash: 'wrong' }), ZERO_HASH, ZERO_HASH)).rejects.toThrow(
      'bf.fileHash'
    )
    await expect(validateBulkFileData(bulkInfo({ lastHash: '11'.repeat(32) }), ZERO_HASH, ZERO_HASH)).rejects.toThrow(
      'bf.lastHash'
    )
    await expect(
      validateBulkFileData(bulkInfo({ lastChainWork: '11'.repeat(32) }), ZERO_HASH, ZERO_HASH)
    ).rejects.toThrow('bf.lastChainWork')
  })

  test('validates buffer framing and accumulates declared chain work', () => {
    const genesis = Uint8Array.from(genesisBuffer('main'))
    expect(() => validateBufferOfHeaders([] as never, ZERO_HASH)).toThrow('Uint8Array')
    expect(() => validateBufferOfHeaders(genesis, ZERO_HASH, genesis.length + 1)).toThrow('offset')
    expect(() => validateBufferOfHeaders(genesis, ZERO_HASH, 0, -2)).toThrow('count')
    expect(() => validateBufferOfHeaders(genesis, '00')).toThrow('previousHash')
    expect(() => validateBufferOfHeaders(genesis, ZERO_HASH, 0, 1, '00')).toThrow('previousChainWork')

    expect(validateBufferOfHeaders(genesis, ZERO_HASH, 0, 1, ZERO_HASH)).toEqual({
      lastHeaderHash: genesisHeader('main').hash,
      lastChainWork: convertBitsToWork(genesisHeader('main').bits)
    })
  })

  test('rejects invalid work, compact targets, and proof hashes', () => {
    expect(() => workBNtoBuffer(new BigNumber(-1))).toThrow('non-negative integer')
    expect(convertBitsToTarget(0x02008000).toString(16)).toBe('80')
    expect(() => convertBitsToTarget([0, 0, -1, 0])).toThrow('byte integers')
    expect(() => convertBitsToWork(0)).toThrow('target encoding')
    expect(() => convertBitsToWork(0x23000001)).toThrow('target encoding')
    expect(() => validateHeaderDifficulty('hash' as never, 0x1d00ffff)).toThrow('exactly 32 bytes')
    expect(() => validateHeaderDifficulty(Array(32).fill(256), 0x1d00ffff)).toThrow('byte integers')
    expect(() => validateHeaderDifficulty(new Uint8Array(31), 0x1d00ffff)).toThrow('exactly 32 bytes')
  })

  test('rejects non-plain headers and invalid scalar conversion flags', () => {
    expect(() => validateHeaderFormat(null as never)).toThrow('Missing header')
    expect(() => validateHeaderFormat([] as never)).toThrow('must be an object')
    expect(() => validateHeaderFormat(Object.create(genesisHeader('main')))).toThrow('plain data object')
    expect(() => deserializeBlockHeader(genesisBuffer('main'), -1)).toThrow('height')
    expect(() => convertUint32ToBuffer(1, 'little' as never)).toThrow('littleEndian')
    expect(() => convertBufferToUint32([0, 0, 0], true)).toThrow('buffer window')
    expect(() => convertBufferToUint32([0, 0, 0, 0, 0], true)).toThrow('exactly four bytes')
    expect(() => convertBufferToUint32([0, 0, 0, 0], 'little' as never)).toThrow('littleEndian')
    expect(() => genesisHeader('mock')).toThrow("does not support 'mock'")
    expect(() => blockHash(new Uint8Array(79))).toThrow('80 bytes long')
  })
})
