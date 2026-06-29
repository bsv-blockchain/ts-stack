import { ArcadeProvider } from '../ArcadeProvider.js'
import { ChaintracksProvider } from '../ChaintracksProvider.js'

const runLive = process.env.RUN_LIVE_OVERLAY_PROVIDER_TESTS === '1'
const describeLive = runLive ? describe : describe.skip

describeLive('Overlay providers live integration', () => {
  jest.setTimeout(30000)

  test.each([
    ['mainnet', process.env.ARCADE_MAINNET_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech'],
    ['teratestnet', process.env.ARCADE_TTN_URL ?? 'https://arcade-v2-ttn-us-1.bsvblockchain.tech']
  ])('reads real %s headers through Arcade go-chaintracks', async (_label, url) => {
    const chaintracks = new ChaintracksProvider(url)
    const height = await chaintracks.currentHeight()
    const header = await chaintracks.findHeaderForHeight(height)

    expect(height).toBeGreaterThan(0)
    expect(header?.height).toBe(height)
    expect(header?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(header?.merkleRoot).toMatch(/^[0-9a-f]{64}$/)
    await expect(chaintracks.isValidRootForHeight(header!.merkleRoot, height)).resolves.toBe(true)
  })

  test('fetches and validates a real mined mainnet Arcade proof', async () => {
    const txid = process.env.ARCADE_PROOF_TXID ?? 'f283c15af7fb9301ef35445eaa76e92d36382880078490b2f4fbae55b6f9551a'
    const arcadeUrl = process.env.ARCADE_MAINNET_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech'
    const arcade = new ArcadeProvider(arcadeUrl)
    const chaintracks = new ChaintracksProvider(arcadeUrl)

    const proof = await arcade.fetchMerkleProof(txid)

    expect(proof).toBeDefined()
    expect(proof?.txid).toBe(txid)
    expect(proof?.blockHeight).toBeGreaterThan(0)
    expect(proof?.merkleRoot).toMatch(/^[0-9a-f]{64}$/)
    await expect(chaintracks.isValidRootForHeight(proof!.merkleRoot, proof!.blockHeight!)).resolves.toBe(true)
  })
})
