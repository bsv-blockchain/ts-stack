import { ChaintracksServiceClient } from '../ChaintracksServiceClient'

function success(value: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', value }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

/** Height 1 of a Teranode regtest chain, exactly as its ChainTracks `findHeaderHexForHeight` serves it. */
const REGTEST_HEADER_1 = {
  version: 536870912,
  previousHash: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
  merkleRoot: '2806ba03abaf970686f301faf707dfd7ab1737221dfb06c0f7a97ff7e71191aa',
  time: 1791194689,
  bits: 545259519,
  nonce: 0,
  height: 1,
  hash: '57581e1a961244ea12424d6b02fb90a36846310cde0b650f771c928ef2cd943b'
}

function regtestService(): typeof fetch {
  return jest.fn(async (url: string) =>
    url.endsWith('/getChain') ? success('regtest') : success(REGTEST_HEADER_1)
  ) as unknown as typeof fetch
}

describe('ChaintracksServiceClient on a regtest deployment', () => {
  test("accepts the service's 'regtest' chain name", async () => {
    const client = new ChaintracksServiceClient('regtest', 'https://chaintracks.example', { fetch: regtestService() })
    await expect(client.getChain()).resolves.toBe('regtest')
  })

  test('accepts regtest headers when configured for regtest', async () => {
    const client = new ChaintracksServiceClient('regtest', 'https://chaintracks.example', { fetch: regtestService() })
    await expect(client.findHeaderForHeight(1)).resolves.toMatchObject({ height: 1, hash: REGTEST_HEADER_1.hash })
  })

  test('a client configured for another chain refuses the regtest service and its headers', async () => {
    const client = new ChaintracksServiceClient('tstn', 'https://chaintracks.example', { fetch: regtestService() })
    await expect(client.getChain()).rejects.toThrow(
      "ChainTracks service chain 'regtest' does not match configured chain 'tstn'."
    )
    await expect(client.findHeaderForHeight(1)).rejects.toThrow('Block target exceeds the proof-of-work limit.')
  })
})
