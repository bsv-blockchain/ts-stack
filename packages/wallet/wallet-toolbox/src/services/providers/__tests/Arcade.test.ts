import {
  HttpClient,
  HttpClientRequestOptions,
  HttpClientResponse,
  Transaction,
  P2PKH,
  PrivateKey,
  Beef,
  MerklePath,
  UnlockingScript
} from '@bsv/sdk'
import { ARC } from '../ARC'
import { Arcade } from '../Arcade'
import { BlockHeader, WalletServices } from '../../../sdk/WalletServices.interfaces'

/**
 * Unit tests for the Arcade (bsv-blockchain/arcade) broadcaster.
 *
 * Arcade extends ARC and differs only where it must:
 *   - endpoints live at `/tx` and `/tx/{txid}` (no `/v1` prefix),
 *   - a submit returns HTTP 202; HTTP 400 is a terminal validation failure (REJECTED),
 *   - submission encoding is Extended Format (EF), not BEEF.
 */

interface CapturedRequest {
  url: string
  options: HttpClientRequestOptions
}

/** A mock HttpClient that records the request and returns a scripted response. */
function mockHttpClient (
  response: Partial<HttpClientResponse<unknown>> | (() => never),
  captured: CapturedRequest[]
): HttpClient {
  return {
    async request<D> (url: string, options: HttpClientRequestOptions): Promise<HttpClientResponse<D>> {
      captured.push({ url, options })
      if (typeof response === 'function') {
        response() // throw to simulate a network error
      }
      return response as HttpClientResponse<D>
    }
  }
}

const RAW_TX = '0100000000000000000000'

describe('Arcade broadcaster', () => {
  describe('construction', () => {
    test('defaults its provider name to "arcade"', () => {
      expect(new Arcade('https://arcade.example').name).toBe('arcade')
    })

    test('standard ARC defaults its name to "ARC"', () => {
      expect(new ARC('https://arc.example').name).toBe('ARC')
    })
  })

  describe('endpoint URLs', () => {
    test('Arcade posts to URL + /tx', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient({ ok: true, status: 202, statusText: 'Accepted', data: { txid: 'abc', status: 202, txStatus: 'RECEIVED' } }, captured)
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      await arc.postRawTx(RAW_TX)
      expect(captured[0].url).toBe('https://arcade.example/tx')
    })

    test('standard ARC posts to URL + /v1/tx', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient({ ok: true, status: 200, statusText: 'OK', data: { txid: 'abc', extraInfo: '', txStatus: 'SEEN_ON_NETWORK' } }, captured)
      const arc = new ARC('https://arc.example', { httpClient: http })
      await arc.postRawTx(RAW_TX)
      expect(captured[0].url).toBe('https://arc.example/v1/tx')
    })

    test('Arcade getTxData hits URL + /tx/{txid}', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient({ ok: true, status: 200, statusText: 'OK', data: { txid: 'deadbeef', txStatus: 'MINED' } }, captured)
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      await arc.getTxData('deadbeef')
      expect(captured[0].url).toBe('https://arcade.example/tx/deadbeef')
    })
  })

  describe('response classification', () => {
    test('202 RECEIVED is a success (not a double spend), with clean data text', async () => {
      const captured: CapturedRequest[] = []
      // Echo back the caller-supplied txid so the "txid altered" annotation is not triggered,
      // isolating the assertion to the extraInfo cosmetic guard (no trailing "undefined").
      const txid = '11'.repeat(32)
      const http = mockHttpClient({ ok: true, status: 202, statusText: 'Accepted', data: { txid, status: 202, txStatus: 'RECEIVED' } }, captured)
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX, [txid])
      expect(r.status).toBe('success')
      expect(r.doubleSpend).toBeFalsy()
      expect(r.data).toBe('RECEIVED')
      expect(r.data).not.toContain('undefined')
    })

    test('Arcade HTTP 400 → status error treated as invalidTx (serviceError=false)', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient({ ok: false, status: 400, statusText: 'Bad Request', data: { error: 'transaction failed validation', reason: 'script evaluation failed' } }, captured)
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX)
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(false)
    })

    test('Arcade HTTP 503 backpressure → transient serviceError=true', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient({ ok: false, status: 503, statusText: 'Service Unavailable', data: { error: 'backpressure' } }, captured)
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX)
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(true)
    })

    test('Arcade network throw → serviceError=true', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(() => { throw new Error('ECONNREFUSED') }, captured)
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX)
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(true)
    })

    test('standard ARC keeps legacy behavior: HTTP 400 → serviceError=true', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient({ ok: false, status: 400, statusText: 'Bad Request', data: { detail: 'bad' } }, captured)
      const arc = new ARC('https://arc.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX)
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(true)
    })
  })

  describe('request headers', () => {
    test('includes XDeployment-ID, Authorization, and X-CallbackToken when configured', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient({ ok: true, status: 202, statusText: 'Accepted', data: { txid: 'abc', status: 202, txStatus: 'RECEIVED' } }, captured)
      const arc = new Arcade('https://arcade.example', {
        httpClient: http,
        apiKey: 'server-key',
        callbackToken: 'wallet-token'
      })
      await arc.postRawTx(RAW_TX)
      const headers = captured[0].options.headers as Record<string, string>
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['XDeployment-ID']).toBeTruthy()
      expect(headers.Authorization).toBe('Bearer server-key')
      expect(headers['X-CallbackToken']).toBe('wallet-token')
      // SSE (pull) flow: no callbackUrl configured → header omitted
      expect(headers['X-CallbackUrl']).toBeUndefined()
    })
  })

  describe('postBeef submits Extended Format (EF), not BEEF', () => {
    const EF_MARKER = '0000000000ef'
    const BEEF_V1_PREFIX = '0100beef'
    const BEEF_V2_PREFIX = '0200beef'

    // Build an in-memory BEEF { sourceTx (anchored by a dummy BUMP) -> spendTx } from which
    // Extended Format can be reconstructed. Also returns an orphan txid whose source is absent.
    function buildBeef (): { beef: Beef, spendTxid: string, orphanTxid: string } {
      const priv = PrivateKey.fromHex('11'.repeat(32))
      const lock = new P2PKH().lock(priv.toPublicKey().toAddress())

      const sourceTx = new Transaction()
      sourceTx.addOutput({ satoshis: 5000, lockingScript: lock })
      sourceTx.merklePath = new MerklePath(800000, [[{ offset: 0, hash: sourceTx.id('hex'), txid: true }]])

      const spendTx = new Transaction()
      spendTx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
      spendTx.addOutput({ satoshis: 4000, lockingScript: lock })

      const orphan = new Transaction()
      orphan.addInput({ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
      orphan.addOutput({ satoshis: 1000, lockingScript: lock })

      const beef = new Beef()
      beef.mergeTransaction(sourceTx)
      beef.mergeTransaction(spendTx)
      return { beef, spendTxid: spendTx.id('hex'), orphanTxid: orphan.id('hex') }
    }

    test('Arcade posts EF hex (with EF marker, not a BEEF prefix) to /tx', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        { ok: true, status: 202, statusText: 'Accepted', data: { txid: '', status: 202, txStatus: 'RECEIVED' } },
        captured
      )
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const { beef, spendTxid } = buildBeef()

      const r = await arc.postBeef(beef, [spendTxid])

      expect(r.status).toBe('success')
      expect(captured).toHaveLength(1)
      expect(captured[0].url).toBe('https://arcade.example/tx')
      const rawTx = (captured[0].options.data as { rawTx: string }).rawTx
      expect(rawTx).toContain(EF_MARKER)
      expect(rawTx.startsWith(BEEF_V1_PREFIX)).toBe(false)
      expect(rawTx.startsWith(BEEF_V2_PREFIX)).toBe(false)
    })

    test('standard ARC still posts BEEF (regression guard for the non-arcade path)', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        { ok: true, status: 200, statusText: 'OK', data: { txid: '', extraInfo: '', txStatus: 'SEEN_ON_NETWORK' } },
        captured
      )
      const arc = new ARC('https://arc.example', { httpClient: http })
      const { beef, spendTxid } = buildBeef()

      await arc.postBeef(beef, [spendTxid])

      const rawTx = (captured[0].options.data as { rawTx: string }).rawTx
      expect(rawTx.startsWith(BEEF_V1_PREFIX) || rawTx.startsWith(BEEF_V2_PREFIX)).toBe(true)
    })

    test('EF build failure → serviceError (no HTTP call) so it falls through to a BEEF-capable provider', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        { ok: true, status: 202, statusText: 'Accepted', data: { txid: '', status: 202, txStatus: 'RECEIVED' } },
        captured
      )
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const { beef, orphanTxid } = buildBeef()

      const r = await arc.postBeef(beef, [orphanTxid])

      expect(r.status).toBe('error')
      const tr = r.txidResults.find(t => t.txid === orphanTxid)
      expect(tr?.serviceError).toBe(true)
      expect(captured).toHaveLength(0)
    })
  })

  describe('getMerklePath provider (proof acquisition)', () => {
    // Real mined transaction + its BUMP from mainnet Arcade (block 955122).
    const F283_TXID = 'f283c15af7fb9301ef35445eaa76e92d36382880078490b2f4fbae55b6f9551a'
    const F283_BLOCKHASH = '000000000000000001577b6b5eaa6a75c6463ba6f143a2340026ccf923ba34fe'
    const F283_HEIGHT = 955122
    const F283_ROOT = '9c95627dacbf19591f68448630d9d9ae1b18fda1c4ca6acc84fd660f66d9f1bf'
    const F283_BUMP =
      'fef2920e00120222021a55f9b655aefbf4b2908407802838362de976aa5e4435ef0193fbf75ac183f2230057eead000df51a926a9f6b3b330f4b028c1f1c27fb218ae408e78feb2a30fa800110005fc2894e94e9009ce8102e1beb99b6a99c352e13502f53fb94e853e3d563bf4d010900d139cc229d5599c75ec9fd094da6faba3e7b97e64b8977317fa84401c17a895f0105000740a1ee710d80805c05d3e835c95d4174ad38695912e96a1c01bc17b282151d01030071c33071477ce0c6a96475bd024ecb8fa555138f47c5bf5fe7f28bf02b42f1020100008cc12b2dc5e57ceb205289260a82114e92101c496f3ccfb4c569b613d8e96a1a01010078224ee8acd16aa820d2a4bf8f022038ff95e9ceee990f08d98c17bb21a7ce8601010083f5508c315f3b7d3352e9fac3eaa6c76c0d4069558473386d31972f40c843f8010100901f20844e8ede781d7c1e8893f725c6bda494899a45a74b175f38d4e1862d76010100903877404503535b4e171ac8c92ab1c6406ab3ac81c89ad87013bb8deb39a7ca010100cdeccbedd2e94eee765e4ea01c0898789df7e9e1825130b7b73db655abd040a501010048ef4e124408fec09fd605875a54cc9bd79557e3ffc68c5011d0f50cdefb59f4010100f5714c108080ed499e7840c3f3e4a52d642723f2c5819ba502c0c00761ad892c010100c31f41af367fbb7f0d31b353a2a4b396e75bf02f122d239da9a1721f24f0dd2e0101008f44d227bcd7b051838ff8f4bffaa418660f440def819cc5a050bad07ef597e9010100c77390cde6d159a78f1543e252b9ab3984f409003d127958be1d91a387ee1c610101008954773b6594d2a1ff601726ff3aa9218282b7ff708cad72c148387f2913abfa010100198bbe74ae81436e36ba87948c8d8a452f30c859af710d71c923030ac2270a39'

    const header = (merkleRoot: string): BlockHeader =>
      ({ height: F283_HEIGHT, hash: F283_BLOCKHASH, merkleRoot } as unknown as BlockHeader)

    // Minimal WalletServices stub exposing only hashToHeader (all this provider uses).
    const fakeServices = (h: BlockHeader | Error): WalletServices =>
      ({ hashToHeader: async () => { if (h instanceof Error) throw h; return h } } as unknown as WalletServices)

    function minedHttp (merklePath: string | undefined, txStatus = 'MINED'): HttpClient {
      const captured: CapturedRequest[] = []
      return mockHttpClient(
        { ok: true, status: 200, statusText: 'OK', data: { txid: F283_TXID, txStatus, blockHeight: F283_HEIGHT, blockHash: F283_BLOCKHASH, merklePath } },
        captured
      )
    }

    test('MINED tx with a BUMP that reconciles to the canonical header → returns merklePath + header', async () => {
      const arc = new Arcade('https://arcade.example', { httpClient: minedHttp(F283_BUMP) })
      const r = await arc.getMerklePath(F283_TXID, fakeServices(header(F283_ROOT)))
      expect(r.merklePath).toBeDefined()
      expect(r.merklePath!.computeRoot(F283_TXID)).toBe(F283_ROOT)
      expect(r.header?.merkleRoot).toBe(F283_ROOT)
      expect(r.error).toBeUndefined()
    })

    test('not-yet-mined tx → no merklePath (falls through to other providers)', async () => {
      const arc = new Arcade('https://arcade.example', { httpClient: minedHttp(undefined, 'SEEN_ON_NETWORK') })
      const r = await arc.getMerklePath(F283_TXID, fakeServices(header(F283_ROOT)))
      expect(r.merklePath).toBeUndefined()
      expect(r.error).toBeUndefined()
    })

    test('BUMP that does not reconcile with the canonical block → rejected (no merklePath)', async () => {
      const arc = new Arcade('https://arcade.example', { httpClient: minedHttp(F283_BUMP) })
      // Header reports a different merkle root than the BUMP computes → must be rejected.
      const r = await arc.getMerklePath(F283_TXID, fakeServices(header('00'.repeat(32))))
      expect(r.merklePath).toBeUndefined()
    })

    test('unknown block (chaintracker throws) → no merklePath, surfaced as error note', async () => {
      const arc = new Arcade('https://arcade.example', { httpClient: minedHttp(F283_BUMP) })
      const r = await arc.getMerklePath(F283_TXID, fakeServices(new Error('unknown blockhash')))
      expect(r.merklePath).toBeUndefined()
      expect(r.error).toBeDefined()
    })
  })
})
