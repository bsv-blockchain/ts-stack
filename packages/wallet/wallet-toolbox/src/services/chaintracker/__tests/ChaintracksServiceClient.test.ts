import { sdk } from '../../../index.client'
import { ChaintracksServiceClient } from '../chaintracks/index.client'

const includeTestChaintracks = false

// Fixtures captured from a healthy chaintracks endpoint
// (e.g. https://chaintracks-us-1.bsvb.tech/findHeaderHexForHeight?height=877595).
// We mock fetch so these tests are independent of the live service.
const HEADER_877595 = {
  version: 671088640,
  previousHash: '00000000000000000337ee607330d9167ae4e0f94d48375c8aab3e88aab9b1f4',
  merkleRoot: 'fba13592ecc6a703d7148378b01f884457bcb81bbdaebee06f9ada204e6cece2',
  time: 1735680482,
  bits: 403546957,
  nonce: 293027114,
  height: 877595,
  hash: '00000000000000000b010edee7422c59ec9131742e35f3e0d5837d710b961406'
}

const realFetch = global.fetch
beforeAll(() => {
  global.fetch = jest.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? ''
    if (url.includes('chaintracks.babbage.systems/findHeaderHexForHeight')) {
      const height = Number(new URL(url).searchParams.get('height'))
      if (height === 877595) {
        return jsonResponse({ status: 'success', value: HEADER_877595 })
      }
      return jsonResponse({ status: 'success' })
    }
    if (url.includes('chaintracks.babbage.systems/findHeaderHexForBlockHash')) {
      const hash = new URL(url).searchParams.get('hash')
      if (hash === HEADER_877595.hash) {
        return jsonResponse({ status: 'success', value: HEADER_877595 })
      }
      // Some deployed services answer a miss with an error payload rather
      // than a success with an undefined value.
      return jsonResponse({ status: 'error', code: 'ERR_NOT_FOUND', description: `header for ${hash} not found` })
    }
    if (url.includes('chaintracks.babbage.systems/getPresentHeight')) {
      return jsonResponse({ status: 'error', code: 'ERR_INTERNAL', description: 'An internal error has occurred.' })
    }
    return realFetch(input, init)
  }) as any
})
afterAll(() => {
  global.fetch = realFetch
})

describe('ChaintracksServiceClient tests', () => {
  jest.setTimeout(99999999)

  test('0 mainNet findHeaderForHeight', async () => {
    const client = makeClient('main')
    const r = await client.findHeaderForHeight(877595)
    expect(r?.hash).toBe('00000000000000000b010edee7422c59ec9131742e35f3e0d5837d710b961406')
    expect(await client.findHeaderForHeight(999999999)).toBe(undefined)
  })

  test('1 testNet findHeaderForHeight', async () => {
    if (!includeTestChaintracks) return
    const client = makeClient('test')
    const r = await client.findHeaderForHeight(1651723)
    expect(r?.hash).toBe('0000000049686fe721f70614c89df146e410240f838b8f3ef8e6471c6dfdd153')
    expect(await client.findHeaderForHeight(999999999)).toBe(undefined)
  })

  test('2 mainNet findHeaderForBlockHash', async () => {
    const client = makeClient('main')
    const r = await client.findHeaderForBlockHash(HEADER_877595.hash)
    expect(r?.height).toBe(877595)
  })

  test('3 findHeaderForBlockHash returns undefined on ERR_NOT_FOUND error payload', async () => {
    const client = makeClient('main')
    const r = await client.findHeaderForBlockHash('00'.repeat(32))
    expect(r).toBeUndefined()
  })

  test('4 other error payloads still throw', async () => {
    const client = makeClient('main')
    await expect(client.getPresentHeight()).rejects.toThrow('ERR_INTERNAL')
  })
})

function makeClient (chain: sdk.Chain) {
  // const chaintracksUrl = `https://npm-registry.babbage.systems:${chain === 'main' ? 8084 : 8083}`
  const chaintracksUrl = `https://${chain}net-chaintracks.babbage.systems`
  return new ChaintracksServiceClient(chain, chaintracksUrl)
}

function jsonResponse (body: unknown): any {
  return { ok: true, status: 200, json: async () => body }
}
