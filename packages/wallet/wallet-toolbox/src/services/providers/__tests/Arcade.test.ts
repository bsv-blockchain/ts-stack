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
import { ARC, type ArcConfig } from '../ARC'
import { Arcade } from '../Arcade'
import { BlockHeader, WalletServices } from '../../../sdk/WalletServices.interfaces'
import { blockHash } from '../../chaintracker/chaintracks/util/blockHeaderUtilities'

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
function mockHttpClient(
  response: Partial<HttpClientResponse<unknown>> | (() => never),
  captured: CapturedRequest[]
): HttpClient {
  return {
    async request<D>(url: string, options: HttpClientRequestOptions): Promise<HttpClientResponse<D>> {
      captured.push({ url, options })
      if (typeof response === 'function') {
        response() // throw to simulate a network error
      }
      return response as HttpClientResponse<D>
    }
  }
}

function mockHttpClientSequence(
  responses: Array<Partial<HttpClientResponse<unknown>>>,
  captured: CapturedRequest[]
): HttpClient {
  return {
    async request<D>(url: string, options: HttpClientRequestOptions): Promise<HttpClientResponse<D>> {
      captured.push({ url, options })
      const response = responses.shift()
      if (response == null) throw new Error('No scripted HTTP response')
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
      const http = mockHttpClient(
        { ok: true, status: 202, statusText: 'Accepted', data: { txid: 'abc', status: 202, txStatus: 'RECEIVED' } },
        captured
      )
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      await arc.postRawTx(RAW_TX)
      expect(captured[0].url).toBe('https://arcade.example/tx')
    })

    test('standard ARC posts to URL + /v1/tx', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        { ok: true, status: 200, statusText: 'OK', data: { txid: 'abc', extraInfo: '', txStatus: 'SEEN_ON_NETWORK' } },
        captured
      )
      const arc = new ARC('https://arc.example', { httpClient: http })
      await arc.postRawTx(RAW_TX)
      expect(captured[0].url).toBe('https://arc.example/v1/tx')
    })

    test('Arcade getTxData hits URL + /tx/{txid}', async () => {
      const captured: CapturedRequest[] = []
      const txid = 'de'.repeat(32)
      const http = mockHttpClient(
        { ok: true, status: 200, statusText: 'OK', data: { txid, txStatus: 'MINED' } },
        captured
      )
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      await arc.getTxData(txid)
      expect(captured[0].url).toBe(`https://arcade.example/tx/${txid}`)
    })

    test('standard ARC rejects mismatched or malformed transaction status data', async () => {
      const txid = 'de'.repeat(32)
      const wrongTxid = 'ad'.repeat(32)
      const mismatched = new ARC('https://arc.example', {
        httpClient: mockHttpClient(
          { ok: true, status: 200, statusText: 'OK', data: { txid: wrongTxid, txStatus: 'MINED' } },
          []
        )
      })
      await expect(mismatched.getTxData(txid)).rejects.toThrow('malformed transaction data')

      const data = Object.defineProperty({ txid }, 'txStatus', {
        enumerable: true,
        get: () => {
          throw new Error('accessor invoked')
        }
      })
      const accessorBacked = new ARC('https://arc.example', {
        httpClient: mockHttpClient({ ok: true, status: 200, statusText: 'OK', data }, [])
      })
      await expect(accessorBacked.getTxData(txid)).rejects.toThrow('malformed transaction data')

      const failed = new ARC('https://arc.example', {
        httpClient: mockHttpClient(
          { ok: false, status: 503, statusText: 'Unavailable', data: { txid, txStatus: 'MINED' } },
          []
        )
      })
      await expect(failed.getTxData(txid)).rejects.toThrow('response 503')
    })
  })

  describe('shared transaction status provider', () => {
    test('maps only network-observed Arcade states to known or mined', async () => {
      const accepted = '01'.repeat(32)
      const mined = '02'.repeat(32)
      const rejected = '03'.repeat(32)
      const missing = '04'.repeat(32)
      const captured: CapturedRequest[] = []
      const http = mockHttpClientSequence(
        [
          { ok: true, status: 200, statusText: 'OK', data: { txid: accepted, txStatus: 'ACCEPTED_BY_NETWORK' } },
          { ok: true, status: 200, statusText: 'OK', data: { txid: mined, txStatus: 'MINED' } },
          { ok: true, status: 200, statusText: 'OK', data: { txid: rejected, txStatus: 'REJECTED' } },
          { ok: false, status: 404, statusText: 'Not Found', data: { error: 'not found' } }
        ],
        captured
      )
      const result = await new Arcade('https://arcade.example', { httpClient: http }).getStatusForTxids([
        accepted,
        mined,
        rejected,
        missing
      ])

      expect(result.status).toBe('success')
      expect(result.results).toEqual([
        { txid: accepted, status: 'known', depth: 0 },
        { txid: mined, status: 'mined', depth: 1 },
        { txid: rejected, status: 'unknown', depth: undefined, providerStatus: 'REJECTED' },
        { txid: missing, status: 'unknown', depth: undefined }
      ])
      expect(captured.map(request => request.url)).toEqual([
        `https://arcade.example/tx/${accepted}`,
        `https://arcade.example/tx/${mined}`,
        `https://arcade.example/tx/${rejected}`,
        `https://arcade.example/tx/${missing}`
      ])
    })

    test('surfaces an orphan-mempool verdict as durable input-conflict evidence', async () => {
      const loser = '11'.repeat(32)
      const winner = '22'.repeat(32)
      const http = mockHttpClient(
        {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: {
            status: 200,
            txid: loser,
            txStatus: 'SEEN_IN_ORPHAN_MEMPOOL',
            extraInfo: 'input conflict',
            competingTxs: [winner]
          }
        },
        []
      )

      const result = await new Arcade('https://arcade.example', { httpClient: http }).getStatusForTxids([loser])

      expect(result.results[0]).toMatchObject({
        txid: loser,
        status: 'unknown',
        terminal: true,
        inputConflict: true,
        providerStatus: 'SEEN_IN_ORPHAN_MEMPOOL',
        competingTxs: [winner]
      })
    })

    test('returns an inconclusive provider result on transport or server failure', async () => {
      const txid = '33'.repeat(32)
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        { ok: false, status: 503, statusText: 'Service Unavailable', data: { error: 'backpressure' } },
        captured
      )
      const result = await new Arcade('https://arcade.example', { httpClient: http }).getStatusForTxids([txid])

      expect(result.status).toBe('error')
      expect(result.results).toEqual([{ txid, status: 'unknown', depth: undefined }])
      expect(result.error).toBeDefined()
    })

    test('rejects a status response bound to a different transaction id', async () => {
      const txid = '44'.repeat(32)
      const http = mockHttpClient(
        {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: { txid: '55'.repeat(32), txStatus: 'MINED' }
        },
        []
      )

      const result = await new Arcade('https://arcade.example', { httpClient: http }).getStatusForTxids([txid])

      expect(result.status).toBe('error')
      expect(result.results).toEqual([{ txid, status: 'unknown', depth: undefined }])
    })

    test('does not invoke accessor-backed Arcade response fields', async () => {
      const txid = '66'.repeat(32)
      let invoked = false
      const data = { txid, txStatus: 'MINED' }
      Object.defineProperty(data, 'extraInfo', {
        enumerable: true,
        get: () => {
          invoked = true
          return 'hidden'
        }
      })
      const http = mockHttpClient({ ok: true, status: 200, statusText: 'OK', data }, [])

      const result = await new Arcade('https://arcade.example', { httpClient: http }).getStatusForTxids([txid])

      expect(result.status).toBe('error')
      expect(invoked).toBe(false)
    })
  })

  describe('response classification', () => {
    test('202 RECEIVED is a success (not a double spend), with clean data text', async () => {
      const captured: CapturedRequest[] = []
      // Echo back the caller-supplied txid so the "txid altered" annotation is not triggered,
      // isolating the assertion to the extraInfo cosmetic guard (no trailing "undefined").
      const txid = '11'.repeat(32)
      const http = mockHttpClient(
        { ok: true, status: 202, statusText: 'Accepted', data: { txid, status: 202, txStatus: 'RECEIVED' } },
        captured
      )
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX, [txid])
      expect(r.status).toBe('success')
      expect(r.doubleSpend).toBeFalsy()
      expect(r.data).toBe('RECEIVED')
      expect(r.data).not.toContain('undefined')
    })

    test('Arcade HTTP 400 → status error treated as invalidTx (serviceError=false)', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          data: { error: 'transaction failed validation', reason: 'script evaluation failed' }
        },
        captured
      )
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX)
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(false)
    })

    test('Arcade HTTP 503 backpressure → transient serviceError=true', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        { ok: false, status: 503, statusText: 'Service Unavailable', data: { error: 'backpressure' } },
        captured
      )
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX)
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(true)
    })

    test('Arcade network throw → serviceError=true', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(() => {
        throw new Error('ECONNREFUSED')
      }, captured)
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX)
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(true)
    })

    test.each([
      {
        name: 'standard ARC',
        create: (http: HttpClient) => new ARC('https://arc.example', { httpClient: http }),
        status: 200
      },
      {
        name: 'Arcade',
        create: (http: HttpClient) => new Arcade('https://arcade.example', { httpClient: http }),
        status: 202
      }
    ])('$name preserves double-spend response details', async ({ create, status }) => {
      const captured: CapturedRequest[] = []
      const txid = '11'.repeat(32)
      const competingTxs = ['22'.repeat(32)]
      const http = mockHttpClient(
        {
          ok: true,
          status,
          statusText: 'Accepted',
          data: {
            txid,
            extraInfo: 'conflict',
            txStatus: 'DOUBLE_SPEND_ATTEMPTED',
            competingTxs
          }
        },
        captured
      )

      const result = await create(http).postRawTx(RAW_TX, [txid])

      expect(result).toMatchObject({
        txid,
        status: 'error',
        doubleSpend: true,
        competingTxs
      })
      expect(result.notes).toEqual([
        expect.objectContaining({
          what: 'postRawTxDoubleSpend',
          txid,
          competingTxs: competingTxs.join(',')
        })
      ])
    })

    test('standard ARC network throw preserves a service-error history note', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(() => {
        throw new Error('ECONNRESET')
      }, captured)
      const result = await new ARC('https://arc.example', {
        httpClient: http
      }).postRawTx(RAW_TX)

      expect(result).toMatchObject({
        status: 'error',
        serviceError: true
      })
      expect(result.notes).toEqual([
        expect.objectContaining({
          what: 'postRawTxCatch',
          description: 'ECONNRESET'
        })
      ])
    })

    test.each([
      {
        name: 'standard ARC',
        create: (http: HttpClient) => new ARC('https://arc.example', { httpClient: http })
      },
      {
        name: 'Arcade',
        create: (http: HttpClient) => new Arcade('https://arcade.example', { httpClient: http })
      }
    ])('$name safely classifies nonstandard status and string error data', async ({ create }) => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        {
          ok: false,
          status: {} as unknown as number,
          statusText: 'Unknown',
          data: 'plain-text failure'
        },
        captured
      )

      const result = await create(http).postRawTx(RAW_TX)

      expect(result).toMatchObject({
        status: 'error',
        serviceError: true,
        data: { status: 'ERR_UNKNOWN' }
      })
      expect(result.notes).toEqual([
        expect.objectContaining({
          what: 'postRawTxError',
          status: 'object',
          data: 'plain-text failure'
        })
      ])
    })

    test('Arcade preserves structured error detail in its result and history', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          data: { detail: 'script evaluation failed' }
        },
        captured
      )

      const result = await new Arcade('https://arcade.example', {
        httpClient: http
      }).postRawTx(RAW_TX)

      expect(result.data).toMatchObject({
        status: '400',
        detail: 'script evaluation failed'
      })
      expect(result.notes).toEqual([
        expect.objectContaining({
          what: 'postRawTxError',
          detail: 'script evaluation failed'
        })
      ])
    })

    test('standard ARC HTTP validation error → status error treated as invalidTx (serviceError=false)', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        { ok: false, status: 464, statusText: 'Invalid Inputs', data: { detail: 'script evaluation failed' } },
        captured
      )
      const arc = new ARC('https://arc.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX)
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(false)
    })

    test('standard ARC HTTP 476 batch limit → transient serviceError=true', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        {
          ok: false,
          status: 476,
          statusText: 'Maximum batch size exceeded',
          data: { detail: 'Maximum batch size exceeded' }
        },
        captured
      )
      const arc = new ARC('https://arc.example', { httpClient: http })
      const r = await arc.postRawTx(RAW_TX)
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(true)
    })

    test.each([
      'RECEIVED',
      'SENT_TO_NETWORK',
      'ANNOUNCED_TO_NETWORK',
      'ACCEPTED_BY_NETWORK',
      'SEEN_ON_NETWORK',
      'STORED',
      'MINED',
      'IMMUTABLE'
    ])('standard ARC postBeef accepts extra txid status %s', async txStatus => {
      const captured: CapturedRequest[] = []
      const lock = new P2PKH().lock(PrivateKey.fromHex('44'.repeat(32)).toPublicKey().toAddress())
      const extraTx = new Transaction()
      extraTx.addOutput({ satoshis: 1, lockingScript: lock })
      const primaryTx = new Transaction()
      primaryTx.addOutput({ satoshis: 2, lockingScript: lock })
      const beef = new Beef()
      beef.mergeTransaction(extraTx)
      beef.mergeTransaction(primaryTx)
      const primaryTxid = primaryTx.id('hex')
      const extraTxid = extraTx.id('hex')
      const http = mockHttpClientSequence(
        [
          {
            ok: true,
            status: 200,
            statusText: 'OK',
            data: { txid: primaryTxid, extraInfo: '', txStatus: 'SEEN_ON_NETWORK' }
          },
          { ok: true, status: 200, statusText: 'OK', data: { txid: extraTxid, txStatus } }
        ],
        captured
      )
      const arc = new ARC('https://arc.example', { httpClient: http })

      const r = await arc.postBeef(beef, [extraTxid, primaryTxid])

      expect(r.status).toBe('success')
      expect(r.txidResults.find(t => t.txid === extraTxid)?.status).toBe('success')
      expect(captured[1].url).toBe(`https://arc.example/v1/tx/${extraTxid}`)
    })
  })

  describe('request headers', () => {
    test('includes XDeployment-ID, Authorization, and X-CallbackToken when configured', async () => {
      const captured: CapturedRequest[] = []
      const http = mockHttpClient(
        { ok: true, status: 202, statusText: 'Accepted', data: { txid: 'abc', status: 202, txStatus: 'RECEIVED' } },
        captured
      )
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

    test.each([
      {
        name: 'standard ARC',
        create: (config: ArcConfig) => new ARC('https://arc.example', config),
        response: {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: { txid: 'abc', extraInfo: '', txStatus: 'SEEN_ON_NETWORK' }
        }
      },
      {
        name: 'Arcade',
        create: (config: ArcConfig) => new Arcade('https://arcade.example', config),
        response: {
          ok: true,
          status: 202,
          statusText: 'Accepted',
          data: { txid: 'abc', status: 202, txStatus: 'RECEIVED' }
        }
      }
    ])('$name snapshots credentials and custom headers', async ({ create, response }) => {
      const captured: CapturedRequest[] = []
      const headers = { 'X-Tenant': 'original' }
      const config: ArcConfig = {
        httpClient: mockHttpClient(response, captured),
        apiKey: 'original-key',
        callbackToken: 'original-token',
        headers
      }
      const provider = create(config)

      config.apiKey = 'mutated-key'
      config.callbackToken = 'mutated-token'
      headers['X-Tenant'] = 'mutated'
      await provider.postRawTx(RAW_TX)

      const sent = captured[0].options.headers as Record<string, string>
      expect(sent.Authorization).toBe('Bearer original-key')
      expect(sent['X-CallbackToken']).toBe('original-token')
      expect(sent['X-Tenant']).toBe('original')
    })

    test.each([
      ['standard ARC', (config: ArcConfig) => new ARC('https://arc.example', config)],
      ['Arcade', (config: ArcConfig) => new Arcade('https://arcade.example', config)]
    ])('%s rejects accessor-backed and prototype-bearing configuration', (_name, create) => {
      const getter = jest.fn(() => 'stolen')
      const accessorConfig: Record<string, unknown> = {}
      Object.defineProperty(accessorConfig, 'apiKey', { enumerable: true, get: getter })
      expect(() => create(accessorConfig as ArcConfig)).toThrow('accessor-free')
      expect(getter).not.toHaveBeenCalled()

      const inheritedHeaders = Object.assign(Object.create({ Authorization: 'inherited' }), {
        'X-Tenant': 'own'
      }) as Record<string, string>
      expect(() => create({ headers: inheritedHeaders })).toThrow('accessor-free')
      expect(() => create({ headers: { 'X-Tenant': undefined as unknown as string } })).toThrow('must be a string')
    })
  })

  describe('postBeef submits Extended Format (EF), not BEEF', () => {
    const EF_MARKER = '0000000000ef'
    const BEEF_V1_PREFIX = '0100beef'
    const BEEF_V2_PREFIX = '0200beef'

    // Build an in-memory BEEF { sourceTx (anchored by a dummy BUMP) -> spendTx } from which
    // Extended Format can be reconstructed. Also returns an orphan txid whose source is absent.
    function buildBeef(): { beef: Beef; spendTxid: string; orphanTxid: string } {
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

    function buildBeefBatch(count: number): { beef: Beef; txids: string[] } {
      const priv = PrivateKey.fromHex('22'.repeat(32))
      const lock = new P2PKH().lock(priv.toPublicKey().toAddress())

      const sourceTx = new Transaction()
      for (let i = 0; i < count; i++) sourceTx.addOutput({ satoshis: 5000, lockingScript: lock })
      sourceTx.merklePath = new MerklePath(800000, [[{ offset: 0, hash: sourceTx.id('hex'), txid: true }]])

      const beef = new Beef()
      beef.mergeTransaction(sourceTx)
      const txids: string[] = []
      for (let i = 0; i < count; i++) {
        const spendTx = new Transaction()
        spendTx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: i, unlockingScript: new UnlockingScript() })
        spendTx.addOutput({ satoshis: 4000, lockingScript: lock })
        beef.mergeTransaction(spendTx)
        txids.push(spendTx.id('hex'))
      }
      return { beef, txids }
    }

    function buildBeefChain(count: number): { beef: Beef; txids: string[] } {
      const priv = PrivateKey.fromHex('33'.repeat(32))
      const lock = new P2PKH().lock(priv.toPublicKey().toAddress())

      let sourceTx = new Transaction()
      sourceTx.addOutput({ satoshis: 5000, lockingScript: lock })
      sourceTx.merklePath = new MerklePath(800000, [[{ offset: 0, hash: sourceTx.id('hex'), txid: true }]])

      const beef = new Beef()
      beef.mergeTransaction(sourceTx)
      const txids: string[] = []
      for (let i = 0; i < count; i++) {
        const spendTx = new Transaction()
        spendTx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
        spendTx.addOutput({ satoshis: 4000 - i, lockingScript: lock })
        beef.mergeTransaction(spendTx)
        txids.push(spendTx.id('hex'))
        sourceTx = spendTx
      }
      return { beef, txids }
    }

    test('Arcade posts EF hex (with EF marker, not a BEEF prefix) to /tx', async () => {
      const captured: CapturedRequest[] = []
      const { beef, spendTxid } = buildBeef()
      const http = mockHttpClient(
        {
          ok: true,
          status: 202,
          statusText: 'Accepted',
          data: { txid: spendTxid, status: 202, txStatus: 'RECEIVED' }
        },
        captured
      )
      const arc = new Arcade('https://arcade.example', { httpClient: http })

      const r = await arc.postBeef(beef, [spendTxid])

      expect(r.status).toBe('success')
      expect(captured).toHaveLength(1)
      expect(captured[0].url).toBe('https://arcade.example/tx')
      const rawTx = (captured[0].options.data as { rawTx: string }).rawTx
      expect(rawTx).toContain(EF_MARKER)
      expect(rawTx.startsWith(BEEF_V1_PREFIX)).toBe(false)
      expect(rawTx.startsWith(BEEF_V2_PREFIX)).toBe(false)
    })

    test('reconstructs EF from a bundle parsed from binary (no pre-linked ancestry)', async () => {
      const captured: CapturedRequest[] = []
      const { beef, spendTxid } = buildBeef()
      const http = mockHttpClient(
        {
          ok: true,
          status: 202,
          statusText: 'Accepted',
          data: { txid: spendTxid, status: 202, txStatus: 'RECEIVED' }
        },
        captured
      )
      const arc = new Arcade('https://arcade.example', { httpClient: http })
      // A wire/storage bundle arrives as binary: its transactions carry no
      // sourceTransaction links until ancestry is attached during extraction.
      const rehydrated = Beef.fromBinary(beef.toBinary())

      const r = await arc.postBeef(rehydrated, [spendTxid])

      expect(r.status).toBe('success')
      expect(captured).toHaveLength(1)
      const rawTx = (captured[0].options.data as { rawTx: string }).rawTx
      expect(rawTx).toContain(EF_MARKER)
      expect(rawTx.startsWith(BEEF_V1_PREFIX)).toBe(false)
      expect(rawTx.startsWith(BEEF_V2_PREFIX)).toBe(false)
    })

    test('standard ARC still posts BEEF (regression guard for the non-arcade path)', async () => {
      const captured: CapturedRequest[] = []
      const { beef, spendTxid } = buildBeef()
      const http = mockHttpClient(
        {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: { txid: spendTxid, extraInfo: '', txStatus: 'SEEN_ON_NETWORK' }
        },
        captured
      )
      const arc = new ARC('https://arc.example', { httpClient: http })

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

      await expect(arc.postBeef(beef, [orphanTxid])).rejects.toThrow('exact ID')
      expect(captured).toHaveLength(0)
    })

    test('submits a multi-transaction BEEF with bounded concurrency and stable result ordering', async () => {
      const { beef, txids } = buildBeefBatch(8)
      let callIndex = 0
      let inFlight = 0
      let maxInFlight = 0
      const http: HttpClient = {
        async request<D>(): Promise<HttpClientResponse<D>> {
          const txid = txids[callIndex++]
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise(resolve => setTimeout(resolve, 10))
          inFlight--
          const response = {
            ok: true,
            status: 202,
            statusText: 'Accepted',
            data: { txid, status: 202, txStatus: 'RECEIVED' }
          }
          return response as HttpClientResponse<D>
        }
      }
      const arc = new Arcade('https://arcade.example', { httpClient: http })

      const r = await arc.postBeef(beef, txids)

      expect(maxInFlight).toBe(4)
      expect(callIndex).toBe(8)
      expect(r.status).toBe('success')
      expect(r.txidResults.map(result => result.txid)).toEqual(txids)
    })

    test('preserves parent-before-child order for a chained BEEF', async () => {
      const { beef, txids } = buildBeefChain(5)
      const callOrder: string[] = []
      let inFlight = 0
      let maxInFlight = 0
      const http: HttpClient = {
        async request<D>(): Promise<HttpClientResponse<D>> {
          const txid = txids[callOrder.length]
          callOrder.push(txid)
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise(resolve => setTimeout(resolve, 5))
          inFlight--
          const response = {
            ok: true,
            status: 202,
            statusText: 'Accepted',
            data: { txid, status: 202, txStatus: 'RECEIVED' }
          }
          return response as HttpClientResponse<D>
        }
      }
      const arc = new Arcade('https://arcade.example', { httpClient: http })

      const r = await arc.postBeef(beef, txids)

      expect(maxInFlight).toBe(1)
      expect(callOrder).toEqual(txids)
      expect(r.status).toBe('success')
    })
  })

  describe('getMerklePath provider (proof acquisition)', () => {
    // Real mined transaction + its BUMP from mainnet Arcade (block 955122).
    const F283_TXID = 'f283c15af7fb9301ef35445eaa76e92d36382880078490b2f4fbae55b6f9551a'
    const F283_HEIGHT = 955122
    const F283_ROOT = '9c95627dacbf19591f68448630d9d9ae1b18fda1c4ca6acc84fd660f66d9f1bf'
    const F283_BUMP =
      'fef2920e00120222021a55f9b655aefbf4b2908407802838362de976aa5e4435ef0193fbf75ac183f2230057eead000df51a926a9f6b3b330f4b028c1f1c27fb218ae408e78feb2a30fa800110005fc2894e94e9009ce8102e1beb99b6a99c352e13502f53fb94e853e3d563bf4d010900d139cc229d5599c75ec9fd094da6faba3e7b97e64b8977317fa84401c17a895f0105000740a1ee710d80805c05d3e835c95d4174ad38695912e96a1c01bc17b282151d01030071c33071477ce0c6a96475bd024ecb8fa555138f47c5bf5fe7f28bf02b42f1020100008cc12b2dc5e57ceb205289260a82114e92101c496f3ccfb4c569b613d8e96a1a01010078224ee8acd16aa820d2a4bf8f022038ff95e9ceee990f08d98c17bb21a7ce8601010083f5508c315f3b7d3352e9fac3eaa6c76c0d4069558473386d31972f40c843f8010100901f20844e8ede781d7c1e8893f725c6bda494899a45a74b175f38d4e1862d76010100903877404503535b4e171ac8c92ab1c6406ab3ac81c89ad87013bb8deb39a7ca010100cdeccbedd2e94eee765e4ea01c0898789df7e9e1825130b7b73db655abd040a501010048ef4e124408fec09fd605875a54cc9bd79557e3ffc68c5011d0f50cdefb59f4010100f5714c108080ed499e7840c3f3e4a52d642723f2c5819ba502c0c00761ad892c010100c31f41af367fbb7f0d31b353a2a4b396e75bf02f122d239da9a1721f24f0dd2e0101008f44d227bcd7b051838ff8f4bffaa418660f440def819cc5a050bad07ef597e9010100c77390cde6d159a78f1543e252b9ab3984f409003d127958be1d91a387ee1c610101008954773b6594d2a1ff601726ff3aa9218282b7ff708cad72c148387f2913abfa010100198bbe74ae81436e36ba87948c8d8a452f30c859af710d71c923030ac2270a39'

    const header = (merkleRoot: string): BlockHeader => {
      const base = {
        version: 1,
        previousHash: '00'.repeat(32),
        merkleRoot,
        time: 1,
        bits: 0,
        nonce: 0
      }
      return { ...base, height: F283_HEIGHT, hash: blockHash(base) }
    }

    // Minimal WalletServices stub exposing only hashToHeader (all this provider uses).
    const fakeServices = (h: BlockHeader | Error): WalletServices =>
      ({
        hashToHeader: async () => {
          if (h instanceof Error) throw h
          return h
        }
      }) as unknown as WalletServices

    function minedHttp(merklePath: string | undefined, txStatus = 'MINED'): HttpClient {
      const captured: CapturedRequest[] = []
      return mockHttpClient(
        {
          ok: true,
          status: 200,
          statusText: 'OK',
          data: {
            txid: F283_TXID,
            txStatus,
            blockHeight: F283_HEIGHT,
            blockHash: header(F283_ROOT).hash,
            merklePath
          }
        },
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

/**
 * bsv-blockchain/arcade API-key authorization: a key is presented as
 * `Authorization: Bearer bsvb_…`; a refused key is answered 401 (403 for a key not allowed to make
 * the call) before the transaction is parsed, and an exhausted quota 429 with Retry-After.
 */
describe('Arcade API key', () => {
  // Shaped like an Arcade key (bsvb_ + 43 base62 + _ + 6 base62) but not a real one.
  const API_KEY = 'bsvb_0000000000000000000000000000000000000000000_000000'
  const TXID = 'ab'.repeat(32)

  const refused = (status: 401 | 403): Partial<HttpClientResponse<unknown>> => ({
    ok: false,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'Forbidden',
    data: { error: 'invalid api key' }
  })

  test('sends the key as a bearer token on every Arcade request', async () => {
    const captured: CapturedRequest[] = []
    const http = mockHttpClientSequence(
      [
        { ok: true, status: 202, statusText: 'Accepted', data: { txid: TXID, status: 202, txStatus: 'RECEIVED' } },
        { ok: true, status: 200, statusText: 'OK', data: { txid: TXID, txStatus: 'SEEN_ON_NETWORK' } },
        { ok: true, status: 200, statusText: 'OK', data: { txid: TXID, txStatus: 'SEEN_ON_NETWORK' } }
      ],
      captured
    )
    const arc = new Arcade('https://arcade.example', { httpClient: http, apiKey: API_KEY })

    await arc.postRawTx(RAW_TX, [TXID])
    await arc.getTxData(TXID)
    await arc.getStatusForTxids([TXID])

    expect(captured.map(c => `${c.options.method ?? 'GET'} ${c.url}`)).toEqual([
      'POST https://arcade.example/tx',
      `GET https://arcade.example/tx/${TXID}`,
      `GET https://arcade.example/tx/${TXID}`
    ])
    for (const c of captured) {
      expect((c.options.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`)
    }
  })

  test('sends no Authorization header when no key is configured', async () => {
    const captured: CapturedRequest[] = []
    const http = mockHttpClientSequence(
      [
        { ok: true, status: 202, statusText: 'Accepted', data: { txid: TXID, status: 202, txStatus: 'RECEIVED' } },
        { ok: true, status: 200, statusText: 'OK', data: { txid: TXID, txStatus: 'SEEN_ON_NETWORK' } }
      ],
      captured
    )
    const arc = new Arcade('https://arcade.example', { httpClient: http })

    await arc.postRawTx(RAW_TX, [TXID])
    await arc.getTxData(TXID)

    expect(captured).toHaveLength(2)
    for (const c of captured) {
      expect(c.options.headers as Record<string, string>).not.toHaveProperty('Authorization')
    }
  })

  test.each([401, 403] as const)(
    'HTTP %i (key refused) → serviceError=true, never an invalid-transaction verdict',
    async status => {
      const captured: CapturedRequest[] = []
      const arc = new Arcade('https://arcade.example', {
        httpClient: mockHttpClient(refused(status), captured),
        apiKey: API_KEY
      })

      const r = await arc.postRawTx(RAW_TX, [TXID])

      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(true)
      expect(r.doubleSpend).toBeFalsy()
      expect(r.data).toMatchObject({ status: String(status), detail: 'Arcade refused the configured API key' })
      expect(r.notes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            what: 'postRawTxError',
            status,
            detail: 'Arcade refused the configured API key'
          })
        ])
      )
    }
  )

  test('HTTP 401 without a configured key says the instance requires one', async () => {
    const arc = new Arcade('https://arcade.example', { httpClient: mockHttpClient(refused(401), []) })

    const r = await arc.postRawTx(RAW_TX, [TXID])

    expect(r.serviceError).toBe(true)
    expect(r.data).toMatchObject({ detail: 'Arcade requires an API key' })
  })

  test('HTTP 429 (quota exhausted) → serviceError=true', async () => {
    const arc = new Arcade('https://arcade.example', {
      httpClient: mockHttpClient(
        { ok: false, status: 429, statusText: 'Too Many Requests', data: { error: 'rate limit exceeded' } },
        []
      ),
      apiKey: API_KEY
    })

    const r = await arc.postRawTx(RAW_TX, [TXID])

    expect(r.status).toBe('error')
    expect(r.serviceError).toBe(true)
  })

  test('postBeef: a refused key marks every txid a service error so the wallet fails over or retries', async () => {
    const key = PrivateKey.fromRandom()
    const lock = new P2PKH().lock(key.toAddress())
    const parent = new Transaction()
    parent.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    parent.addOutput({ lockingScript: lock, satoshis: 1000 })
    const child = new Transaction()
    child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    child.addOutput({ lockingScript: lock, satoshis: 900 })
    const beef = new Beef()
    beef.mergeTransaction(parent)
    beef.mergeTransaction(child)
    const childTxid = child.id('hex')

    const captured: CapturedRequest[] = []
    const arc = new Arcade('https://arcade.example', {
      httpClient: mockHttpClient(refused(401), captured),
      apiKey: API_KEY
    })

    const r = await arc.postBeef(beef, [childTxid])

    // the request really reached Arcade (EF was built) and was refused there
    expect(captured).toHaveLength(1)
    expect((captured[0].options.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`)
    expect(r.status).toBe('error')
    expect(r.txidResults).toHaveLength(1)
    expect(r.txidResults[0]).toMatchObject({ txid: childTxid, status: 'error', serviceError: true })
  })

  test.each([401, 403] as const)('getTxData rejects on HTTP %i instead of reporting the tx unknown', async status => {
    const arc = new Arcade('https://arcade.example', {
      httpClient: mockHttpClient(refused(status), []),
      apiKey: API_KEY
    })
    await expect(arc.getTxData(TXID)).rejects.toThrow(`Arcade transaction data response ${status}`)
  })

  test('getStatusForTxids on HTTP 401 is an inconclusive provider error, not "unknown"', async () => {
    const arc = new Arcade('https://arcade.example', {
      httpClient: mockHttpClient(refused(401), []),
      apiKey: API_KEY
    })
    const r = await arc.getStatusForTxids([TXID])
    expect(r.status).toBe('error')
  })
})
