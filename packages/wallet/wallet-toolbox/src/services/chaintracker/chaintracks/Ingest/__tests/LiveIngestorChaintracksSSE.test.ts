import { LiveIngestorChaintracksSSE } from '../LiveIngestorChaintracksSSE'

describe('LiveIngestorChaintracksSSE', () => {
  test('pushes subscribed remote headers into the local live header queue', async () => {
    const header = {
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot: '11'.repeat(32),
      time: 1,
      bits: 2,
      nonce: 3,
      height: 99,
      hash: '22'.repeat(32)
    }
    let listener: any
    const chaintracks = {
      getChain: jest.fn(async () => 'main'),
      subscribeHeaders: jest.fn(async cb => {
        listener = cb
        return 'sub-1'
      }),
      unsubscribe: jest.fn(async () => true),
      findHeaderForBlockHash: jest.fn(async () => header)
    } as any
    const ingestor = new LiveIngestorChaintracksSSE({
      chain: 'main',
      chaintracks
    })
    const liveHeaders: any[] = []

    const listening = ingestor.startListening(liveHeaders)
    await new Promise(resolve => setTimeout(resolve, 0))
    listener(header)
    ingestor.stopListening()
    await listening

    expect(liveHeaders).toEqual([header])
    expect(chaintracks.unsubscribe).toHaveBeenCalledWith('sub-1')
    await expect(ingestor.getHeaderByHash(header.hash)).resolves.toEqual(header)
  })

  test('does not leak a subscription when shutdown wins the network-check race', async () => {
    let resolveNetwork!: (chain: 'main') => void
    const network = new Promise<'main'>(resolve => {
      resolveNetwork = resolve
    })
    const chaintracks = {
      getChain: jest.fn(async () => await network),
      subscribeHeaders: jest.fn(async () => 'sub-1'),
      unsubscribe: jest.fn(async () => true)
    } as any
    const ingestor = new LiveIngestorChaintracksSSE({ chain: 'main', chaintracks })

    const listening = ingestor.startListening([])
    ingestor.stopListening()
    resolveNetwork('main')
    await listening

    expect(chaintracks.subscribeHeaders).not.toHaveBeenCalled()
    expect(chaintracks.unsubscribe).not.toHaveBeenCalled()
  })
})
