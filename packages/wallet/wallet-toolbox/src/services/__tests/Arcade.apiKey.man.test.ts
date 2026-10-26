import { HttpClient, HttpClientRequestOptions, HttpClientResponse, Random } from '@bsv/sdk'
import { toHex } from '@bsv/sdk/primitives/utils'
import { Arcade } from '../providers/Arcade'

/**
 * Live tests of Arcade API-key authorization (bsv-blockchain/arcade auth middleware) against a
 * real instance. Excluded from `pnpm test` (matches *.man.test.ts) and skipped unless
 * ARCADE_LIVE_API_KEY is set:
 *
 *   ARCADE_LIVE_API_KEY=bsvb_… pnpm test:manual -- src/services/__tests/Arcade.apiKey.man.test.ts
 *
 * ARCADE_LIVE_URL overrides the instance (default https://broadcast.bsvblockchain.tech).
 * (Distinct from Arcade.man.test.ts's ARCADE_URL / ARCADE_API_KEY, which target an instance
 * without auth by default.)
 *
 * Fund-free: the only broadcast is a transaction Arcade must reject; everything else is a read.
 * One bad-key request per run keeps well under Arcade's per-IP invalid-key throttle (60/min).
 */

const ARCADE_LIVE_URL = (process.env.ARCADE_LIVE_URL ?? 'https://broadcast.bsvblockchain.tech').replace(/\/+$/, '')
const ARCADE_LIVE_API_KEY = process.env.ARCADE_LIVE_API_KEY ?? ''
const describeLive = ARCADE_LIVE_API_KEY !== '' ? describe : describe.skip

// A transaction without its inputs' source data, which Arcade must reject (HTTP 400).
const UNACCEPTABLE_TX_HEX =
  '0100000001abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678900000000025100ffffffff0100e1f505000000001976a914eb0bd5edba389198e73f8efabddfc61666969ff788ac00000000'

const randomTxid = (): string => toHex(Random(32))

/**
 * A fetch-backed HttpClient that records the RateLimit-Policy header of each response: it names
 * the tier Arcade charged the request to ("anonymous" when no key was accepted).
 */
function policyRecordingHttpClient(policies: Array<string | null>): HttpClient {
  return {
    async request<D>(url: string, options: HttpClientRequestOptions): Promise<HttpClientResponse<D>> {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.data != null ? JSON.stringify(options.data) : undefined,
        signal: options.signal
      })
      policies.push(response.headers.get('RateLimit-Policy'))
      const text = await response.text()
      let data: unknown = text
      try {
        data = JSON.parse(text)
      } catch {}
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        data
      } as HttpClientResponse<D>
    }
  }
}

describeLive('Arcade API key (live)', () => {
  jest.setTimeout(60000)

  test('the key is accepted and the request is charged to its tier, not anonymous', async () => {
    const policies: Array<string | null> = []
    const arcade = new Arcade(ARCADE_LIVE_URL, {
      apiKey: ARCADE_LIVE_API_KEY,
      httpClient: policyRecordingHttpClient(policies)
    })

    const r = await arcade.getStatusForTxids([randomTxid()])

    // 404 for an unknown txid (not 401): the lookup ran
    expect(r.status).toBe('success')
    expect(r.results).toEqual([expect.objectContaining({ status: 'unknown' })])
    expect(policies).toHaveLength(1)
    // a tier without a quota sends no RateLimit-Policy at all, which is also keyed
    expect(policies[0] ?? '').not.toMatch(/^"anonymous"/)
  })

  test('with the default transport, a lookup of an unknown txid is authorized (404, not 401)', async () => {
    const arcade = new Arcade(ARCADE_LIVE_URL, { apiKey: ARCADE_LIVE_API_KEY })
    await expect(arcade.getTxData(randomTxid())).rejects.toThrow('Arcade transaction data response 404')
  })

  test('a broadcast is authorized: Arcade judges the transaction (invalidTx), it does not refuse the key', async () => {
    const arcade = new Arcade(ARCADE_LIVE_URL, { apiKey: ARCADE_LIVE_API_KEY })

    const r = await arcade.postRawTx(UNACCEPTABLE_TX_HEX)

    expect(r.status).toBe('error')
    expect(r.serviceError).toBe(false)
    expect(r.data).toMatchObject({ status: '400' })
  })

  test('a refused key is a service error, never an invalid-transaction verdict', async () => {
    // right shape, wrong checksum: refused by Arcade before the transaction is read
    const arcade = new Arcade(ARCADE_LIVE_URL, { apiKey: 'bsvb_0000000000000000000000000000000000000000000_000000' })

    const r = await arcade.postRawTx(UNACCEPTABLE_TX_HEX)

    expect(r.status).toBe('error')
    expect(r.serviceError).toBe(true)
    expect(r.data).toMatchObject({ status: '401', detail: 'Arcade refused the configured API key' })
  })
})
