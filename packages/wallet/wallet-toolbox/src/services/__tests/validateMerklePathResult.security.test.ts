import { MerklePath } from '@bsv/sdk'
import { Services } from '../Services'
import { ServiceCollection } from '../ServiceCollection'
import { GetMerklePathService } from '../../sdk/WalletServices.interfaces'
import {
  authenticateMerklePathResult,
  snapshotMerklePathResult,
  validateMerklePathResult
} from '../validateMerklePathResult'
import { convertProofToMerklePath } from '../../utility/tscProofToMerklePath'

const GENESIS_TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
const GENESIS_HEADER = {
  version: 1,
  previousHash: '00'.repeat(32),
  merkleRoot: GENESIS_TXID,
  time: 1231006505,
  bits: 486604799,
  nonce: 2083236893,
  height: 0,
  hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
}

function result(txid = GENESIS_TXID) {
  return {
    name: 'test',
    merklePath: new MerklePath(0, [[{ offset: 0, hash: txid, txid: true }]]),
    header: { ...GENESIS_HEADER, merkleRoot: txid }
  }
}

describe('Merkle proof trust-boundary validation', () => {
  test('copies and binds a proof to its explicit txid leaf, height, and header root', () => {
    const source = result()
    const validated = validateMerklePathResult(GENESIS_TXID, source, true)

    expect(validated.merklePath).not.toBe(source.merklePath)
    expect(validated.header).not.toBe(source.header)
    expect(validated.root).toBe(GENESIS_TXID)
    expect(validated.index).toBe(0)
  })

  test.each([
    {
      label: 'root mismatch',
      mutate: (candidate: ReturnType<typeof result>) => {
        candidate.header.merkleRoot = '11'.repeat(32)
      }
    },
    {
      label: 'height mismatch',
      mutate: (candidate: ReturnType<typeof result>) => {
        candidate.merklePath.blockHeight = 1
      }
    }
  ])('rejects $label', ({ mutate }) => {
    const candidate = result()
    mutate(candidate)
    expect(() => validateMerklePathResult(GENESIS_TXID, candidate)).toThrow()
  })

  test('binds an unmarked transaction leaf by its requested hash', () => {
    const candidate = result()
    delete candidate.merklePath.path[0][0].txid

    expect(validateMerklePathResult(GENESIS_TXID, candidate).index).toBe(0)
  })

  test('does not invoke accessor-backed Merkle path fields', () => {
    let invoked = false
    const merklePath = {
      blockHeight: 0,
      get path() {
        invoked = true
        return [[{ offset: 0, hash: GENESIS_TXID, txid: true }]]
      }
    }
    expect(() =>
      validateMerklePathResult(GENESIS_TXID, {
        merklePath: merklePath as unknown as MerklePath,
        header: GENESIS_HEADER
      })
    ).toThrow('accessor-free')
    expect(invoked).toBe(false)
  })

  test('bounds path depth and rejects a forged computeRoot method', () => {
    const oversized = {
      blockHeight: 0,
      path: Array.from({ length: 33 }, () => []),
      computeRoot: () => GENESIS_TXID
    } as unknown as MerklePath
    expect(() =>
      validateMerklePathResult(GENESIS_TXID, {
        merklePath: oversized,
        header: GENESIS_HEADER
      })
    ).toThrow()

    const forged = {
      blockHeight: 0,
      path: [[{ offset: 0, hash: '22'.repeat(32), txid: true }]],
      computeRoot: () => GENESIS_TXID
    } as unknown as MerklePath
    expect(() =>
      validateMerklePathResult(GENESIS_TXID, {
        merklePath: forged,
        header: GENESIS_HEADER
      })
    ).toThrow()
  })

  test('requires an affirmative local chain-root verdict', async () => {
    const isValidRootForHeight = jest.fn(async () => false)
    await expect(authenticateMerklePathResult(GENESIS_TXID, result(), { isValidRootForHeight }, true)).rejects.toThrow(
      'chain tracker'
    )
    expect(isValidRootForHeight).toHaveBeenCalledWith(GENESIS_TXID, 0)
  })

  test('rejects a truthy non-boolean chain-root verdict', async () => {
    const isValidRootForHeight = jest.fn(async () => 'true' as unknown as boolean)
    await expect(authenticateMerklePathResult(GENESIS_TXID, result(), { isValidRootForHeight }, true)).rejects.toThrow(
      'chain tracker'
    )
  })

  test('Services rejects a forged provider result, falls through, and returns owned authenticated data', async () => {
    const options = Services.createDefaultOptions('main')
    options.chaintracks = {
      findHeaderForBlockHash: async (hash: string) => (hash === GENESIS_HEADER.hash ? GENESIS_HEADER : undefined)
    } as any
    const services = new Services(options)
    const forged: GetMerklePathService = async () => ({
      ...result(),
      name: 'forged',
      header: { ...GENESIS_HEADER, merkleRoot: '33'.repeat(32) }
    })
    const source = result()
    const valid: GetMerklePathService = async () => source
    services.getMerklePathServices = new ServiceCollection('getMerklePath', [
      { name: 'forged', service: forged },
      { name: 'valid', service: valid }
    ])
    jest.spyOn(services, 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async (root: string, height: number) => root === GENESIS_TXID && height === 0
    })

    const response = await services.getMerklePath(GENESIS_TXID)

    expect(response.name).toBe('valid')
    expect(response.merklePath).not.toBe(source.merklePath)
    expect(response.header).not.toBe(source.header)
    expect(response.merklePath?.computeRoot(GENESIS_TXID)).toBe(GENESIS_TXID)
    const history = services.getMerklePathServices.getServiceCallHistory()
    expect(history.historyByProvider.forged.totalCounts.error).toBe(1)
    expect(history.historyByProvider.valid.totalCounts.success).toBe(1)
  })

  test('snapshots bounded provider notes and does not invoke envelope accessors', () => {
    const source = {
      name: 'remote',
      notes: [{ what: 'proofLookup', description: 'no proof yet' }]
    }
    const snapshot = snapshotMerklePathResult(source)
    source.notes[0].description = 'changed'
    expect(snapshot.notes).toEqual([{ what: 'proofLookup', description: 'no proof yet' }])

    let invoked = false
    const accessor = { name: 'remote' }
    Object.defineProperty(accessor, 'merklePath', {
      enumerable: true,
      get: () => {
        invoked = true
        return result().merklePath
      }
    })
    expect(() => snapshotMerklePathResult(accessor)).toThrow('accessor-free')
    expect(invoked).toBe(false)
  })

  test('bounds legacy proof candidates and provider diagnostics', () => {
    expect(() =>
      snapshotMerklePathResult(
        {
          merklePath: Array.from({ length: 9 }, () => result().merklePath)
        },
        true
      )
    ).toThrow('at most 8')
    expect(() =>
      snapshotMerklePathResult({
        notes: [{ what: 'proofLookup', description: 'x'.repeat(513) }]
      })
    ).toThrow('at most 512')
    expect(() =>
      snapshotMerklePathResult({
        notes: [{ what: 'proofLookup', description: 'forged\nline' }]
      })
    ).toThrow('control characters')
  })

  test('TSC conversion rejects unsafe integers, sparse arrays, malformed nodes, and excessive depth', () => {
    const base = { height: 1, index: 0, nodes: ['*'] }
    expect(() => convertProofToMerklePath(GENESIS_TXID, { ...base, index: 2 ** 31 })).toThrow('index')
    expect(() => convertProofToMerklePath(GENESIS_TXID, { ...base, nodes: Array(33).fill('*') })).toThrow('nodes')
    expect(() => convertProofToMerklePath(GENESIS_TXID, { ...base, nodes: ['not-a-hash'] })).toThrow('node')
    const sparse = Array<string>(2)
    sparse[1] = '*'
    expect(() => convertProofToMerklePath(GENESIS_TXID, { ...base, nodes: sparse })).toThrow('dense')
  })
})
