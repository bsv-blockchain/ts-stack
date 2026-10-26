import type { ChaintracksFetchApi } from '../../Api/ChaintracksFetchApi'
import type { BulkHeaderFileInfo } from '../BulkHeaderFile'
import { isBaseBlockHeader, isBlockHeader, isLiveBlockHeader } from '../../Api/BlockHeaderApi'
import {
  addWork,
  convertBitsToTarget,
  convertBitsToWork,
  convertBufferToUint32,
  deserializeBaseBlockHeader,
  deserializeBaseBlockHeaders,
  deserializeBlockHeaders,
  genesisBuffer,
  isMoreWork,
  readUInt32BE,
  readUInt32LE,
  serializeBaseBlockHeader,
  serializeBaseBlockHeaders,
  subWork,
  validateBufferOfHeaders,
  validateBulkFileData,
  writeUInt32BE,
  writeUInt32LE
} from '../blockHeaderUtilities'

describe('block-header primitive security boundaries', () => {
  const genesis = Uint8Array.from(genesisBuffer('main'))

  test('honors zero counts and rejects unsafe decode windows and amplification', () => {
    expect(deserializeBaseBlockHeaders(genesis, 0, 0)).toEqual([])
    expect(() => deserializeBaseBlockHeaders(genesis, 0.5)).toThrow('offset')
    expect(() => deserializeBaseBlockHeaders(genesis, 0, 0.5)).toThrow('count')
    expect(() => deserializeBaseBlockHeader(genesis.subarray(0, 79))).toThrow('buffer window')
    expect(() => deserializeBlockHeaders(0x7fffffff, new Uint8Array(160))).toThrow('supported block heights')
    expect(() => deserializeBaseBlockHeaders(new Uint8Array(100_001 * 80))).toThrow('100000 headers')
  })

  test('validates serializer inputs before allocation or byte coercion', () => {
    const header = deserializeBlockHeaders(0, genesis)[0]!
    expect(serializeBaseBlockHeader(header)).toEqual(Array.from(genesis))
    expect(() => serializeBaseBlockHeader({ ...header, nonce: 1.5 })).toThrow('nonce must be an integer')
    expect(() => serializeBaseBlockHeader(header, Array(80), -1)).toThrow('offset')
    expect(() => serializeBaseBlockHeaders(Array(2) as never)).toThrow('dense array')
    expect(() => serializeBaseBlockHeaders(Array(100_001) as never)).toThrow('100000')

    let invoked = false
    const accessor = { ...header }
    Object.defineProperty(accessor, 'nonce', {
      enumerable: true,
      get: () => {
        invoked = true
        return header.nonce
      }
    })
    expect(() => serializeBaseBlockHeader(accessor)).toThrow('accessor-free')
    expect(invoked).toBe(false)
  })

  test('requires exact 256-bit work and rejects arithmetic underflow and overflow', () => {
    const zero = '00'.repeat(32)
    const one = `${'00'.repeat(31)}01`
    const max = 'ff'.repeat(32)
    expect(addWork(zero, one)).toBe(one)
    expect(isMoreWork(one, zero)).toBe(true)
    expect(() => isMoreWork('01', zero)).toThrow('32 hexadecimal bytes')
    expect(() => subWork(zero, one)).toThrow('non-negative subtraction')
    expect(() => addWork(max, one)).toThrow('no greater than 256 bits')
  })

  test('rejects malformed compact targets and preserves unsigned 32-bit byte semantics', () => {
    expect(() => convertBitsToTarget(-1)).toThrow('bits')
    expect(() => convertBitsToTarget([1, 2, 3])).toThrow('four bytes')
    expect(() => convertBitsToWork(0x1d80ffff)).toThrow('target encoding')
    expect(() => convertBitsToWork(0x1d010000)).toThrow('target exceeds')

    const bytes = [0xff, 0xff, 0xff, 0xff]
    expect(readUInt32LE(bytes, 0)).toBe(0xffffffff)
    expect(readUInt32BE(bytes, 0)).toBe(0xffffffff)
    expect(convertBufferToUint32(bytes)).toBe(0xffffffff)
    expect(writeUInt32LE(0xffffffff, Array(4), 0)).toBe(4)
    expect(writeUInt32BE(0xffffffff, Array(4), 0)).toBe(4)
    expect(() => readUInt32LE([0, 0, 0], 0)).toThrow('buffer window')
  })

  test('requires exact bounded validation framing and authenticates metadata before download', async () => {
    const previousHash = '00'.repeat(32)
    expect(validateBufferOfHeaders(genesis, previousHash, 0, 0)).toEqual({
      lastHeaderHash: previousHash,
      lastChainWork: undefined
    })
    expect(() => validateBufferOfHeaders(genesis, previousHash, 0, 0.5)).toThrow('count')
    expect(() => validateBufferOfHeaders(new Uint8Array(81), previousHash)).toThrow('complete sequence')

    const fetch = {
      pathJoin: jest.fn(() => 'https://headers.example/file'),
      download: jest.fn()
    } as unknown as ChaintracksFetchApi
    const invalid = {
      chain: 'main',
      count: Number.MAX_SAFE_INTEGER,
      fileName: 'mainNet_0.headers',
      firstHeight: 0,
      prevHash: previousHash,
      prevChainWork: previousHash,
      lastHash: '',
      lastChainWork: '',
      fileHash: '',
      sourceUrl: 'https://headers.example'
    } as BulkHeaderFileInfo
    await expect(validateBulkFileData(invalid, previousHash, previousHash, fetch)).rejects.toThrow('bf.count')
    expect(fetch.download).not.toHaveBeenCalled()
  })

  test('type guards reject partial, accessor-backed, and malformed header objects', () => {
    const header = deserializeBlockHeaders(0, genesis)[0]!
    expect(isBaseBlockHeader(header)).toBe(true)
    expect(isBlockHeader(header)).toBe(true)
    expect(isLiveBlockHeader(header)).toBe(false)
    expect(isBaseBlockHeader({ previousHash: header.previousHash } as never)).toBe(false)
    expect(isBlockHeader({ ...header, height: -1 } as never)).toBe(false)

    let invoked = false
    const accessor = { ...header }
    Object.defineProperty(accessor, 'height', {
      enumerable: true,
      get: () => {
        invoked = true
        return 0
      }
    })
    expect(isBlockHeader(accessor)).toBe(false)
    expect(invoked).toBe(false)
  })
})
