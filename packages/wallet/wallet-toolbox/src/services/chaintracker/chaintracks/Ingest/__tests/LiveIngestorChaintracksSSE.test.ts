import { LiveIngestorChaintracksSSE } from '../LiveIngestorChaintracksSSE'
import type { BlockHeader } from '../../Api/BlockHeaderApi'
import { blockHash, deserializeBaseBlockHeaders, genesisBuffer } from '../../util/blockHeaderUtilities'

function validMainHeader(height: number): BlockHeader {
  const base = deserializeBaseBlockHeaders(genesisBuffer('main'))[0]!
  return { ...base, height, hash: blockHash(base) }
}

describe('LiveIngestorChaintracksSSE', () => {
  test('pushes subscribed remote headers into the local live header queue', async () => {
    const header = validMainHeader(99)
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

  test('drops invalid or excess upstream events without growing the local queue', async () => {
    let listener: (header: BlockHeader) => void = () => {}
    const valid = validMainHeader(1)
    const chaintracks = {
      getChain: jest.fn(async () => 'main'),
      subscribeHeaders: jest.fn(async cb => {
        listener = cb
        return 'sub-1'
      }),
      unsubscribe: jest.fn(async () => true)
    } as any
    const ingestor = new LiveIngestorChaintracksSSE({
      chain: 'main',
      chaintracks,
      maxQueuedHeaders: 1
    })
    const liveHeaders: BlockHeader[] = []
    const listening = ingestor.startListening(liveHeaders)
    await new Promise(resolve => setTimeout(resolve, 0))

    listener({ ...valid, hash: '33'.repeat(32) })
    listener(valid)
    listener(validMainHeader(2))

    expect(liveHeaders).toEqual([valid])
    ingestor.stopListening()
    await listening
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

  test('rejects a mismatched upstream network', async () => {
    const chaintracks = {
      getChain: jest.fn(async () => 'test'),
      subscribeHeaders: jest.fn()
    } as any
    const ingestor = new LiveIngestorChaintracksSSE({ chain: 'main', chaintracks })

    await expect(ingestor.startListening([])).rejects.toThrow("network 'test' does not match configured chain 'main'")
    expect(chaintracks.subscribeHeaders).not.toHaveBeenCalled()
  })

  test('unsubscribes when shutdown wins the pending subscribe race', async () => {
    let resolveSubscription!: (id: string) => void
    const subscription = new Promise<string>(resolve => {
      resolveSubscription = resolve
    })
    const chaintracks = {
      getChain: jest.fn(async () => 'main'),
      subscribeHeaders: jest.fn(async () => await subscription),
      unsubscribe: jest.fn(async () => true)
    } as any
    const ingestor = new LiveIngestorChaintracksSSE({ chain: 'main', chaintracks })

    const listening = ingestor.startListening([])
    await new Promise(resolve => setTimeout(resolve, 0))
    ingestor.stopListening()
    resolveSubscription('sub-race')
    await listening

    expect(chaintracks.unsubscribe).toHaveBeenCalledWith('sub-race')
  })
})
