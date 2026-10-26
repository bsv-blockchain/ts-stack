import ARC from '../ARC.js'
import type Transaction from '../../Transaction.js'
import type { HttpClient, HttpClientRequestOptions } from '../../http/HttpClient.js'

const TXID = 'a'.repeat(64)
const OTHER_TXID = 'b'.repeat(64)

function transaction(txid = TXID): Transaction {
  return {
    toHexEF: () => '00',
    toHex: () => '00',
    id: () => txid
  } as unknown as Transaction
}

function client(data: unknown, ok = true): { httpClient: HttpClient; request: jest.Mock } {
  const request = jest.fn(async () => ({
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? 'OK' : 'Bad Request',
    data
  }))
  return { httpClient: { request: request as HttpClient['request'] }, request }
}

function accepted(txid = TXID): Record<string, unknown> {
  return { txid, txStatus: 'SEEN_ON_NETWORK', extraInfo: '' }
}

describe('ARC security boundaries', () => {
  it('snapshots credentials and own custom headers at construction', async () => {
    const { httpClient, request } = client(accepted())
    const headers = { 'X-Operator': 'original' }
    const config = { apiKey: 'original-key', headers, httpClient }
    const broadcaster = new ARC('https://arc.example', config)

    config.apiKey = 'attacker-key'
    headers['X-Operator'] = 'attacker-value'
    await broadcaster.broadcast(transaction())

    const options = request.mock.calls[0][1] as HttpClientRequestOptions
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer original-key',
      'X-Operator': 'original'
    })
    expect(Object.isFrozen(broadcaster.headers)).toBe(true)
  })

  it('rejects accessor-backed and inherited configuration without invoking accessors', () => {
    let reads = 0
    const config = {}
    Object.defineProperty(config, 'apiKey', {
      enumerable: true,
      get: () => {
        reads++
        return 'attacker-key'
      }
    })
    expect(() => new ARC('https://arc.example', config)).toThrow(/accessor-free/)
    expect(reads).toBe(0)

    const inheritedHeaders = Object.create({ Authorization: 'Bearer attacker-key' })
    inheritedHeaders['X-Own'] = 'allowed-looking'
    expect(
      () =>
        new ARC('https://arc.example', {
          headers: inheritedHeaders
        })
    ).toThrow(/accessor-free/)
  })

  it('rejects control characters and malformed custom header names', () => {
    expect(() => new ARC('https://arc.example', { apiKey: 'safe\r\nInjected: yes' })).toThrow(
      /control characters/
    )
    expect(() => new ARC('https://arc.example', { headers: { 'Bad Header': 'value' } })).toThrow(
      /header name/
    )
    expect(() => new ARC('https://arc.example', { headers: { 'X-Safe': 'bad\nvalue' } })).toThrow(
      /control characters/
    )
  })

  it('does not invoke provider response accessors', async () => {
    let reads = 0
    const data: Record<string, unknown> = {
      txid: TXID,
      extraInfo: ''
    }
    Object.defineProperty(data, 'txStatus', {
      enumerable: true,
      get: () => {
        reads++
        return 'SEEN_ON_NETWORK'
      }
    })
    const { httpClient } = client(data)

    await expect(
      new ARC('https://arc.example', { httpClient }).broadcast(transaction())
    ).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_INVALID_RESPONSE'
    })
    expect(reads).toBe(0)
  })

  it('accepts only known success states and owns competing transaction identifiers', async () => {
    const competingTxs = ['c'.repeat(64)]
    const { httpClient } = client({
      ...accepted(),
      competingTxs
    })
    const result = await new ARC('https://arc.example', { httpClient }).broadcast(transaction())
    expect(result).toEqual({
      status: 'success',
      txid: TXID,
      message: 'SEEN_ON_NETWORK',
      competingTxs: ['c'.repeat(64)]
    })
    competingTxs[0] = OTHER_TXID
    expect(result).toMatchObject({ competingTxs: ['c'.repeat(64)] })

    const unknown = client({ ...accepted(), txStatus: 'ATTACKER_APPROVED' })
    await expect(
      new ARC('https://arc.example', { httpClient: unknown.httpClient }).broadcast(transaction())
    ).resolves.toMatchObject({ status: 'error', code: 'ERR_INVALID_RESPONSE' })
  })

  it('normalizes every batch result instead of returning provider-owned objects', async () => {
    const first = { ...accepted(TXID), attackerField: 'not returned' }
    const second = { ...accepted(OTHER_TXID), txStatus: 'ATTACKER_APPROVED' }
    const { httpClient } = client([first, second])
    const results = await new ARC('https://arc.example', { httpClient }).broadcastMany([
      transaction(TXID),
      transaction(OTHER_TXID)
    ])

    expect(results[0]).toEqual({
      status: 'success',
      txid: TXID,
      message: 'SEEN_ON_NETWORK'
    })
    expect(results[0]).not.toBe(first)
    expect(results[1]).toMatchObject({ status: 'error', code: 'ERR_INVALID_RESPONSE' })
  })

  it('does not reflect transport exceptions or accessor-backed error bodies', async () => {
    const rejectingClient: HttpClient = {
      request: jest.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8443 with secret-token')
      }) as HttpClient['request']
    }
    await expect(
      new ARC('https://arc.example', { httpClient: rejectingClient }).broadcast(transaction())
    ).resolves.toEqual({
      status: 'error',
      code: '500',
      description: 'Internal Server Error'
    })

    let reads = 0
    const errorBody: Record<string, unknown> = {}
    Object.defineProperty(errorBody, 'detail', {
      enumerable: true,
      get: () => {
        reads++
        return 'attacker detail'
      }
    })
    const failed = client(errorBody, false)
    await expect(
      new ARC('https://arc.example', { httpClient: failed.httpClient }).broadcast(transaction())
    ).resolves.toEqual({ status: 'error', code: '400', description: 'Unknown error' })
    expect(reads).toBe(0)
  })
})
