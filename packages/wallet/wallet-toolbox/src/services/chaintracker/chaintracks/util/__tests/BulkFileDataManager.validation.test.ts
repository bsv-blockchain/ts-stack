import type { BulkHeaderFileInfo } from '../BulkHeaderFile'
import {
  BulkFileDataManager,
  normalizeBulkHeaderFileInfo,
  normalizeBulkHeaderFilesInfo,
  normalizeBulkHeaderFileSequence,
  selectBulkHeaderFiles
} from '../BulkFileDataManager'

const ZERO_HASH = '00'.repeat(32)
const ONE_HASH = '11'.repeat(32)
const TWO_HASH = '22'.repeat(32)
const FILE_HASH_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const FILE_HASH_B = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

function file(overrides: Partial<BulkHeaderFileInfo> = {}): BulkHeaderFileInfo {
  return {
    chain: 'main',
    count: 1,
    firstHeight: 0,
    fileName: 'mainNet_0.headers',
    fileHash: FILE_HASH_A,
    prevHash: ZERO_HASH,
    lastHash: ONE_HASH,
    prevChainWork: ZERO_HASH,
    lastChainWork: ONE_HASH,
    ...overrides
  }
}

describe('BulkFileDataManager metadata boundaries', () => {
  test('normalizes stored booleans, nullable source URLs, and owned byte data', () => {
    const data = Uint8Array.of(1, 2, 3)
    const normalized = normalizeBulkHeaderFileInfo(
      file({ fileId: 7, validated: 1 as unknown as boolean, sourceUrl: null as unknown as string, data }),
      true
    )

    expect(normalized).toMatchObject({ fileId: 7, validated: true, sourceUrl: undefined })
    expect(normalized.data).toEqual(data)
    expect(normalized.data).not.toBe(data)
  })

  test('rejects missing or accessor-backed metadata without invoking accessors', () => {
    const missing = file() as Record<string, unknown>
    delete missing.count
    expect(() => normalizeBulkHeaderFileInfo(missing)).toThrow('bulk file count')

    const getter = jest.fn(() => 'main')
    const accessor = { ...file() }
    Object.defineProperty(accessor, 'chain', { enumerable: true, get: getter })
    expect(() => normalizeBulkHeaderFileInfo(accessor)).toThrow('own data property')
    expect(getter).not.toHaveBeenCalled()
  })

  test.each([
    ['unsupported chain', { chain: 'production' }],
    ['zero count', { count: 0 }],
    ['overflowing range', { firstHeight: 0x7fffffff, count: 2 }],
    ['path-bearing name', { fileName: '../headers' }],
    ['noncanonical digest', { fileHash: 'A'.repeat(42) + 'B=' }],
    ['short previous hash', { prevHash: '00' }],
    ['control-bearing URL', { sourceUrl: 'https://headers.example\nforged' }],
    ['zero file ID', { fileId: 0 }],
    ['coerced validated flag', { validated: 'true' }],
    ['non-byte data', { data: [1, 2, 3] }]
  ])('rejects %s', (_name, override) => {
    expect(() => normalizeBulkHeaderFileInfo(file(override as Partial<BulkHeaderFileInfo>))).toThrow()
  })

  test('normalizes a bounded manifest and rejects sparse entries', () => {
    expect(
      normalizeBulkHeaderFilesInfo({
        files: [file()],
        headersPerFile: 100,
        rootFolder: '/headers',
        jsonFilename: 'main.json'
      })
    ).toMatchObject({ headersPerFile: 100, rootFolder: '/headers', files: [{ count: 1 }] })
    expect(normalizeBulkHeaderFilesInfo({ files: [file()], headersPerFile: 100 })).toMatchObject({
      rootFolder: '',
      jsonFilename: ''
    })

    const sparse: BulkHeaderFileInfo[] = []
    sparse.length = 1
    expect(() => normalizeBulkHeaderFilesInfo({ files: sparse, headersPerFile: 100 })).toThrow('dense array')
    expect(() => normalizeBulkHeaderFileSequence(sparse)).toThrow('dense array')
    expect(() => normalizeBulkHeaderFilesInfo({ files: [], headersPerFile: 0 })).toThrow('headersPerFile')
  })

  test('requires a unique, genesis-anchored contiguous sequence', () => {
    expect(() => normalizeBulkHeaderFileSequence([file({ firstHeight: 1 })])).toThrow('genesis-anchored')
    expect(() => normalizeBulkHeaderFileSequence([file(), file()])).toThrow('unique file hashes')
    expect(() =>
      normalizeBulkHeaderFileSequence([
        file({ fileId: 1 }),
        file({
          fileId: 1,
          fileHash: FILE_HASH_B,
          firstHeight: 1,
          prevHash: ONE_HASH,
          prevChainWork: ONE_HASH,
          lastHash: TWO_HASH,
          lastChainWork: TWO_HASH
        })
      ])
    ).toThrow('unique file ids')
    expect(() =>
      normalizeBulkHeaderFileSequence([
        file(),
        file({ fileHash: FILE_HASH_B, firstHeight: 2, prevHash: ONE_HASH, prevChainWork: ONE_HASH })
      ])
    ).toThrow('contiguous')
    expect(() =>
      normalizeBulkHeaderFileSequence([
        file({ fileName: 'incremental' }),
        file({ fileHash: FILE_HASH_B, firstHeight: 1, prevHash: ONE_HASH, prevChainWork: ONE_HASH })
      ])
    ).toThrow('final position')
  })

  test('selects the longest unambiguous file at each contiguous height', () => {
    const short = file()
    const long = file({ count: 2, fileHash: FILE_HASH_B, lastHash: TWO_HASH, lastChainWork: TWO_HASH })
    expect(selectBulkHeaderFiles([short, long], 'main', 2)).toEqual([expect.objectContaining({ count: 2 })])
    expect(() => selectBulkHeaderFiles([short], 'invalid' as never, 1)).toThrow('supported Chaintracks network')
    expect(() => selectBulkHeaderFiles([short], 'main', 0)).toThrow('maxPerFile')

    const sparse: BulkHeaderFileInfo[] = []
    sparse.length = 1
    expect(() => selectBulkHeaderFiles(sparse, 'main', 1)).toThrow('dense array')
    expect(() => selectBulkHeaderFiles([short, file({ fileHash: FILE_HASH_B })], 'main', 1)).toThrow('unambiguous')
  })

  test('never selects a file labelled with another chain, so regtest rules cannot reach a mainnet tracker', () => {
    const regtestFile = file({ chain: 'regtest', fileName: 'regtestNet_0.headers' })
    expect(selectBulkHeaderFiles([regtestFile], 'main', 1)).toEqual([])
    expect(selectBulkHeaderFiles([regtestFile], 'regtest', 1)).toEqual([expect.objectContaining({ chain: 'regtest' })])
  })

  test.each([
    ['options', null],
    ['chain', { chain: 'invalid', maxPerFile: 1 }],
    ['maxPerFile', { chain: 'main', maxPerFile: 0 }],
    ['maxRetained', { chain: 'main', maxPerFile: 1, maxRetained: 1001 }],
    ['fromKnownSourceUrl', { chain: 'main', maxPerFile: 1, fromKnownSourceUrl: 'x\rforged' }],
    ['validator', { chain: 'main', maxPerFile: 1, validator: {} }],
    ['cache', { chain: 'main', maxPerFile: 1, cache: { get: () => undefined } }],
    ['downloadBudget', { chain: 'main', maxPerFile: 1, downloadBudget: {} }]
  ])('rejects invalid %s configuration', (_name, options) => {
    expect(() => new BulkFileDataManager(options as never)).toThrow()
  })

  test('validates the complete persistent-storage boundary before reading it', async () => {
    const manager = new BulkFileDataManager({ chain: 'main', maxPerFile: 1 })
    await expect(manager.setStorage(null as never, jest.fn())).rejects.toThrow('storage')

    const storage = {
      getBulkFiles: jest.fn(),
      getBulkFileData: jest.fn(),
      insertBulkFile: jest.fn(),
      updateBulkFile: jest.fn(),
      deleteBulkFile: jest.fn()
    }
    await expect(manager.setStorage(storage as never, null as never)).rejects.toThrow('log')
    expect(storage.getBulkFiles).not.toHaveBeenCalled()
  })

  test('rejects unsafe export arguments before touching the filesystem', async () => {
    const manager = new BulkFileDataManager({ chain: 'main', maxPerFile: 1 })
    const fs = { pathJoin: jest.fn() }

    await expect(manager.exportHeadersToFs(fs as never, 0, '/headers')).rejects.toThrow('toHeadersPerFile')
    await expect(manager.exportHeadersToFs(fs as never, 1, '/headers', undefined, -1)).rejects.toThrow('maxHeight')
    await expect(manager.exportHeadersToFs(fs as never, 1, '\n')).rejects.toThrow('toFolder')
    await expect(manager.exportHeadersToFs(fs as never, 1, '/headers', 'https://x\nforged')).rejects.toThrow(
      'sourceUrl'
    )
    expect(fs.pathJoin).not.toHaveBeenCalled()
  })
})
