import { ChaintracksChainTracker } from '../index.all'
import { sdk } from '../../../index.client'

const includeTestChaintracks = false

// Fixtures captured from a healthy chaintracks endpoint
// (e.g. https://chaintracks-us-1.bsvb.tech). Mock fetch to keep the test offline.
const HEADER_877599 = {
  version: 570425344,
  previousHash: '00000000000000000a71b1ecfe047c69ca1817156a64c0cb8e40104e9c4af68a',
  merkleRoot: '2bf2edb5fa42aa773c6c13bc90e097b4e7de7ca1df2227f433be75ceace339e9',
  time: 1735682483,
  bits: 403553918,
  nonce: 2672581460,
  height: 877599,
  hash: '000000000000000001f67f9c4c4babc21d396fc15f70a6ca6fc70c6bcb17d90e'
}

const realFetch = global.fetch
beforeAll(() => {
  global.fetch = jest.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? ''
    if (url.includes('chaintracks.babbage.systems/getPresentHeight')) {
      return jsonResponse({ status: 'success', value: 950000 })
    }
    if (url.includes('chaintracks.babbage.systems/findHeaderHexForHeight')) {
      const height = Number(new URL(url).searchParams.get('height'))
      if (height === 877599) {
        return jsonResponse({ status: 'success', value: HEADER_877599 })
      }
      return jsonResponse({ status: 'success' })
    }
    return realFetch(input, init)
  }) as any
})
afterAll(() => {
  global.fetch = realFetch
})

describe('ChaintracksChaintracker tests', () => {
  jest.setTimeout(99999999)

  test('0 test', async () => {
    if (!includeTestChaintracks) return
    await testChaintracksChaintracker('test')
  })

  test('1 main', async () => {
    await testChaintracksChaintracker('main')
  })
})

async function testChaintracksChaintracker (chain: sdk.Chain) {
  const tracker = new ChaintracksChainTracker(chain)
  const height = await tracker.currentHeight()
  expect(height).toBeGreaterThan(877598)
  const okMain = await tracker.isValidRootForHeight(
    '2bf2edb5fa42aa773c6c13bc90e097b4e7de7ca1df2227f433be75ceace339e9',
    877599
  )
  expect(okMain).toBe(chain === 'main')
  const okTest = await tracker.isValidRootForHeight(
    '5513f13554442588dd9acf395072bf1d2e7d5d360fbc42d3ab1fa2026b17c200',
    1654265
  )
  expect(okTest).toBe(chain === 'test')
}

function jsonResponse (body: unknown): any {
  return { ok: true, status: 200, json: async () => body }
}
