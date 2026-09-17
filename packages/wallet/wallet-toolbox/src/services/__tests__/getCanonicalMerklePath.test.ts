import { ChainTracker, MerklePath } from '@bsv/sdk'
import { ServiceCollection } from '../ServiceCollection'
import { Services } from '../Services'
import { getCanonicalMerklePath, validateCanonicalMerklePathResult } from '../getCanonicalMerklePath'
import { GetMerklePathResult, GetMerklePathService, WalletServices } from '../../sdk/WalletServices.interfaces'

const txid = '11'.repeat(32)
const staleSibling = '22'.repeat(32)
const canonicalSibling = '33'.repeat(32)
const height = 100

function resultFor(sibling: string, name: string): GetMerklePathResult {
  const merklePath = new MerklePath(height, [
    [
      { offset: 0, hash: txid, txid: true },
      { offset: 1, hash: sibling }
    ]
  ])
  const merkleRoot = merklePath.computeRoot(txid)
  return {
    name,
    merklePath,
    header: {
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot,
      time: 0,
      bits: 0,
      nonce: 0,
      height,
      hash: sibling
    }
  }
}

function trackerFor(canonicalRoot: string): ChainTracker {
  return {
    isValidRootForHeight: jest.fn(
      async (root: string, candidateHeight: number) => root === canonicalRoot && candidateHeight === height
    )
  } as ChainTracker
}

describe('canonical Merkle path acquisition', () => {
  test('Services skips a stale provider result and accepts the next canonical proof', async () => {
    const stale = resultFor(staleSibling, 'stale')
    const canonical = resultFor(canonicalSibling, 'canonical')
    const tracker = trackerFor(canonical.header!.merkleRoot)
    const services = new Services(Services.createDefaultOptions('main'))
    const staleProvider = jest.fn(async () => stale)
    const canonicalProvider = jest.fn(async () => canonical)
    services.getMerklePathServices = new ServiceCollection<GetMerklePathService>('getMerklePath')
      .add({ name: 'stale', service: staleProvider })
      .add({ name: 'canonical', service: canonicalProvider })
    jest.spyOn(services, 'getChainTracker').mockResolvedValue(tracker)

    const result = await services.getMerklePath(txid)

    expect(result.name).toBe('canonical')
    expect(result.header?.merkleRoot).toBe(canonical.header?.merkleRoot)
    expect(staleProvider).toHaveBeenCalledTimes(1)
    expect(canonicalProvider).toHaveBeenCalledTimes(1)
  })

  test('custom services without provider failover reject a non-canonical proof', async () => {
    const stale = resultFor(staleSibling, 'stale')
    const canonical = resultFor(canonicalSibling, 'canonical')
    const services = {
      getMerklePath: jest.fn(async () => stale)
    } as unknown as WalletServices

    const result = await getCanonicalMerklePath(services, trackerFor(canonical.header!.merkleRoot), txid)

    expect(result.merklePath).toBeUndefined()
    expect(result.error).toBeDefined()
  })

  test('accepts a canonical proof when a provider omits the optional header', async () => {
    const canonical = resultFor(canonicalSibling, 'canonical')
    const result = { ...canonical, header: undefined }

    await validateCanonicalMerklePathResult(txid, result, trackerFor(canonical.header!.merkleRoot))

    expect(result.merklePath).toEqual(canonical.merklePath)
  })

  test('accepts a canonical proof whose path omits the optional txid marker', async () => {
    const canonical = resultFor(canonicalSibling, 'canonical')
    const unmarkedPath = new MerklePath(height, [
      [
        { offset: 0, hash: txid },
        { offset: 1, hash: canonicalSibling }
      ]
    ])
    const result = { ...canonical, merklePath: unmarkedPath }

    await validateCanonicalMerklePathResult(txid, result, trackerFor(canonical.header!.merkleRoot))

    expect(result.merklePath).toEqual(unmarkedPath)
  })

  test('array results remove stale paths before persistence', async () => {
    const stale = resultFor(staleSibling, 'stale')
    const canonical = resultFor(canonicalSibling, 'canonical')
    const result: GetMerklePathResult = {
      ...canonical,
      merklePath: [stale.merklePath as MerklePath, canonical.merklePath as MerklePath] as unknown as MerklePath
    }

    await validateCanonicalMerklePathResult(txid, result, trackerFor(canonical.header!.merkleRoot))

    expect(result.merklePath).toEqual(canonical.merklePath)
  })
})
