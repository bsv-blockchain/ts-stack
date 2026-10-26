import ARC from '../broadcasters/ARC.js'
import Teranode from '../broadcasters/Teranode.js'
import WhatsOnChainBroadcaster from '../broadcasters/WhatsOnChainBroadcaster.js'
import { BlockHeadersService } from '../chaintrackers/BlockHeadersService.js'
import WhatsOnChain from '../chaintrackers/WhatsOnChain.js'
import type Transaction from '../Transaction.js'
import type { HttpClient } from '../http/HttpClient.js'

const TXID = 'a'.repeat(64)
const OTHER_TXID = 'b'.repeat(64)

function transaction(txid = TXID): Transaction {
  return {
    toHexEF: () => '00',
    toHex: () => '00',
    toEF: () => [0],
    id: () => txid
  } as unknown as Transaction
}

function client(data: unknown, ok = true): HttpClient {
  return {
    request: jest.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'Error',
      data
    })) as HttpClient['request']
  }
}

describe('broadcast and chain-service result binding', () => {
  it('binds ARC and WhatsOnChain success to the submitted txid', async () => {
    const arc = new ARC('https://arc.example', {
      httpClient: client({ txid: OTHER_TXID, txStatus: 'SEEN_ON_NETWORK', extraInfo: '' })
    })
    await expect(arc.broadcast(transaction())).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_TXID_MISMATCH'
    })

    const whatsOnChain = new WhatsOnChainBroadcaster('main', client(OTHER_TXID))
    await expect(whatsOnChain.broadcast(transaction())).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_TXID_MISMATCH'
    })
  })

  it('rejects foreign and duplicate identities in ARC batch acknowledgements', async () => {
    const broadcaster = new ARC('https://arc.example', {
      httpClient: client([
        { txid: TXID, txStatus: 'SEEN_ON_NETWORK' },
        { txid: TXID, txStatus: 'SEEN_ON_NETWORK' }
      ])
    })
    const results = await broadcaster.broadcastMany([transaction(TXID), transaction(OTHER_TXID)])
    expect(results[0]).toMatchObject({ txid: TXID })
    expect(results[1]).toMatchObject({ status: 'error', code: 'ERR_TXID_MISMATCH' })
  })

  it('requires a confirmed Block Headers Service record for the requested root and height', async () => {
    const tracker = new BlockHeadersService('https://headers.example', {
      httpClient: client({
        confirmationState: 'CONFIRMED',
        confirmations: [
          {
            blockHash: 'c'.repeat(64),
            blockHeight: 100,
            merkleRoot: OTHER_TXID,
            confirmation: 'CONFIRMED'
          }
        ]
      })
    })
    await expect(tracker.isValidRootForHeight(TXID, 100)).resolves.toBe(false)
  })

  it('rejects mutable/accessor-backed chain-service configuration without reading it', () => {
    let reads = 0
    const config = {}
    Object.defineProperty(config, 'apiKey', {
      enumerable: true,
      get: () => {
        reads++
        return 'attacker-key'
      }
    })
    expect(() => new BlockHeadersService('https://headers.example', config)).toThrow(
      /accessor-free/
    )
    expect(reads).toBe(0)

    expect(() => new WhatsOnChain('attacker/path' as 'main', {})).toThrow(/network must be/i)
  })

  it('does not invoke accessor-backed chain-provider responses', async () => {
    let reads = 0
    const confirmation: Record<string, unknown> = {}
    Object.defineProperty(confirmation, 'confirmationState', {
      enumerable: true,
      get: () => {
        reads++
        return 'CONFIRMED'
      }
    })
    const headers = new BlockHeadersService('https://headers.example', {
      httpClient: client(confirmation)
    })
    await expect(headers.isValidRootForHeight(TXID, 100)).resolves.toBe(false)
    expect(reads).toBe(0)

    const blockHeader: Record<string, unknown> = {}
    Object.defineProperty(blockHeader, 'merkleroot', {
      enumerable: true,
      get: () => {
        reads++
        return TXID
      }
    })
    const whatsOnChain = new WhatsOnChain('main', { httpClient: client(blockHeader) })
    await expect(whatsOnChain.isValidRootForHeight(TXID, 100)).resolves.toBe(false)
    expect(reads).toBe(0)
  })

  it('bounds provider diagnostics and does not reflect transport exceptions', async () => {
    const failedClient = client({ secret: 'provider-owned object' }, false)
    const whatsOnChain = new WhatsOnChainBroadcaster('main', failedClient)
    await expect(whatsOnChain.broadcast(transaction())).resolves.toEqual({
      status: 'error',
      code: '500',
      description: 'Unknown error'
    })

    const rejectingClient: HttpClient = {
      request: jest.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8443 secret-token')
      }) as HttpClient['request']
    }
    const teranode = new Teranode('https://teranode.example/tx', rejectingClient)
    await expect(teranode.broadcast(transaction())).resolves.toEqual({
      status: 'error',
      code: '500',
      description: 'Internal Server Error'
    })
  })
})
