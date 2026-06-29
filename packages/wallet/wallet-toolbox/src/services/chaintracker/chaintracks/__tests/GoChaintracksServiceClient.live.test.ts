import { GoChaintracksServiceClient } from '../GoChaintracksServiceClient'

const runLive = process.env.RUN_LIVE_CHAINTRACKS_TESTS === '1'
const describeLive = runLive ? describe : describe.skip

describeLive('GoChaintracksServiceClient live Arcade integration', () => {
  jest.setTimeout(30000)

  test.each([
    ['main' as const, 'https://arcade-v2-us-1.bsvblockchain.tech'],
    ['ttn' as const, 'https://arcade-v2-ttn-us-1.bsvblockchain.tech']
  ])('reads real %s headers from Arcade go-chaintracks', async (chain, baseUrl) => {
    const client = new GoChaintracksServiceClient(chain, baseUrl, { apiPrefix: '/chaintracks/v2' })
    const height = await client.getPresentHeight()
    const tip = await client.findChainTipHeader()
    const byHeight = await client.findHeaderForHeight(tip.height)
    const byHash = await client.findHeaderForBlockHash(tip.hash)
    const headerBytes = await client.getHeaders(tip.height, 1)

    expect(height).toBeGreaterThan(0)
    expect(tip.height).toBe(height)
    expect(tip.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(tip.merkleRoot).toMatch(/^[0-9a-f]{64}$/)
    expect(byHeight?.hash).toBe(tip.hash)
    expect(byHash?.height).toBe(tip.height)
    expect(headerBytes).toMatch(/^[0-9a-f]+$/)
    expect(headerBytes.length).toBe(160)
  })

  test('receives a real mainnet tip event from Arcade go-chaintracks SSE', async () => {
    const client = new GoChaintracksServiceClient('main', 'https://arcade-v2-us-1.bsvblockchain.tech', {
      apiPrefix: '/chaintracks/v2'
    })
    let timeout: NodeJS.Timeout | undefined
    let subscriptionId = ''
    const received = new Promise<any>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('timed out waiting for tip SSE event')), 15000)
      client.subscribeHeaders(header => resolve(header))
        .then(id => { subscriptionId = id })
        .catch(reject)
    })

    const header = await received
    if (timeout != null) clearTimeout(timeout)
    if (subscriptionId !== '') await client.unsubscribe(subscriptionId)
    expect(header.height).toBeGreaterThan(0)
    expect(header.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
