import { BHServiceClient } from '../BHServiceClient'
import { LocalChainTracker } from '../LocalChainTracker'
import type { ChaintracksClientApi } from '../chaintracks/Api/ChaintracksClientApi'
import { BlockHeader } from '../../../sdk/WalletServices.interfaces'

const height = 100
const queried = 'aa'.repeat(32)
const canonical = 'bb'.repeat(32)
const reorged = 'cc'.repeat(32)

function header(merkleRoot: string): BlockHeader {
  return {
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot,
    time: 1,
    bits: 1,
    nonce: 1,
    height,
    hash: 'dd'.repeat(32)
  }
}

function localClient(): ChaintracksClientApi {
  return {
    getPresentHeight: jest.fn(async () => height),
    findChainTipHash: jest.fn(async () => queried),
    findHeaderForHeight: jest.fn(async () => header(queried)),
    isValidRootForHeight: jest.fn(async () => {
      throw new Error('local unavailable')
    }),
    startListening: jest.fn(async () => undefined),
    listening: jest.fn(async () => undefined)
  } as unknown as ChaintracksClientApi
}

function bhsClient(): BHServiceClient {
  const client = new BHServiceClient('main', 'https://headers.example', 'test-key')
  jest.spyOn(client.bhs, 'isValidRootForHeight')
  return client
}

describe('BHServiceClient height-root cache', () => {
  test('does not invert a false result into a cached positive for the queried root', async () => {
    const client = bhsClient()
    jest.spyOn(client, 'findHeaderForHeight').mockResolvedValue(header(canonical))
    ;(client.bhs.isValidRootForHeight as jest.Mock).mockResolvedValue(false)

    await expect(client.isValidRootForHeight(queried, height)).resolves.toBe(false)
    await expect(client.isValidRootForHeight(queried, height)).resolves.toBe(false)
    expect(client.findHeaderForHeight).toHaveBeenCalledTimes(2)
    expect(client.cache[height]).toBe(canonical)
  })

  test('re-reads a later different root at the same height', async () => {
    const client = bhsClient()
    jest
      .spyOn(client, 'findHeaderForHeight')
      .mockResolvedValueOnce(header(queried))
      .mockResolvedValueOnce(header(canonical))
    ;(client.bhs.isValidRootForHeight as jest.Mock).mockResolvedValue(true)

    await expect(client.isValidRootForHeight(queried, height)).resolves.toBe(true)
    await expect(client.isValidRootForHeight(canonical, height)).resolves.toBe(true)
    expect(client.findHeaderForHeight).toHaveBeenCalledTimes(2)
    expect(client.cache[height]).toBe(canonical)
  })

  test('does not reuse a positive after the canonical header at that height changes', async () => {
    const client = bhsClient()
    jest
      .spyOn(client, 'findHeaderForHeight')
      .mockResolvedValueOnce(header(queried))
      .mockResolvedValueOnce(header(reorged))
    ;(client.bhs.isValidRootForHeight as jest.Mock).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(client.isValidRootForHeight(queried, height)).resolves.toBe(true)
    await expect(client.isValidRootForHeight(queried, height)).resolves.toBe(false)
    expect(client.findHeaderForHeight).toHaveBeenCalledTimes(2)
    expect(client.cache[height]).toBe(reorged)
  })

  test('does not cache a queried root when the canonical header is missing', async () => {
    const client = bhsClient()
    jest.spyOn(client, 'findHeaderForHeight').mockResolvedValue(undefined)
    ;(client.bhs.isValidRootForHeight as jest.Mock).mockResolvedValue(false)

    await expect(client.isValidRootForHeight(queried, height)).resolves.toBe(false)
    expect(client.cache[height]).toBeUndefined()
  })

  test('LocalChainTracker fallback re-reads BHServiceClient roots instead of the queried-root cache', async () => {
    const fallback = bhsClient()
    jest.spyOn(fallback, 'findHeaderForHeight').mockResolvedValue(header(canonical))
    ;(fallback.bhs.isValidRootForHeight as jest.Mock).mockResolvedValue(false)
    const tracker = new LocalChainTracker({
      local: localClient(),
      fallbacks: [fallback],
      mode: 'remote-only'
    })

    await expect(tracker.isValidRootForHeight(queried, height)).resolves.toBe(false)
    await expect(tracker.isValidRootForHeight(queried, height)).resolves.toBe(false)
    expect(fallback.findHeaderForHeight).toHaveBeenCalledTimes(2)
    expect(fallback.cache[height]).toBe(canonical)
  })
})
