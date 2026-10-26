import type { GASPInitialRequest, GASPInitialResponse, GASPNode } from '@bsv/gasp'
import { Transaction } from '@bsv/sdk'
import { OverlayGASPRemote } from '../GASP/OverlayGASPRemote.js'

const rawTx = '01000000000000000000'
const txid = Transaction.fromHex(rawTx).id('hex')
const graphID = `${txid}.0`

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

describe('OverlayGASPRemote', () => {
  let fetchImpl: jest.MockedFunction<typeof fetch>
  let overlayRemote: OverlayGASPRemote

  beforeEach(() => {
    fetchImpl = jest.fn()
    overlayRemote = new OverlayGASPRemote('https://peer.example', 'tm_test', fetchImpl)
  })

  it('requires credential-free HTTPS peer endpoints even with an injected transport', () => {
    expect(() => new OverlayGASPRemote('http://127.0.0.1', 'tm_test', fetchImpl)).toThrow(
      'credential-free HTTPS'
    )
    expect(() => new OverlayGASPRemote('https://user:pass@peer.example', 'tm_test', fetchImpl)).toThrow(
      'credential-free HTTPS'
    )
    expect(() => new OverlayGASPRemote('https://peer.example?redirect=internal', 'tm_test', fetchImpl)).toThrow(
      'credential-free HTTPS'
    )
  })

  describe('getInitialResponse', () => {
    const request: GASPInitialRequest = { version: 1, since: 0, limit: 10 }
    const validResponse: GASPInitialResponse = {
      UTXOList: [{ txid, outputIndex: 0, score: 1 }],
      since: 1234567890
    }

    it('sends the bounded request and returns an exactly validated response', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(validResponse))

      await expect(overlayRemote.getInitialResponse(request)).resolves.toEqual(validResponse)
      expect(fetchImpl).toHaveBeenCalledWith('https://peer.example/requestSyncResponse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BSV-Topic': 'tm_test'
        },
        body: JSON.stringify(request)
      })
    })

    it('rejects HTTP failures without consuming unbounded diagnostic text', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ error: 'failure' }, { status: 500 }))

      await expect(overlayRemote.getInitialResponse(request)).rejects.toThrow(
        'Overlay peer returned HTTP 500'
      )
    })

    it.each([
      [{ invalid: 'data' }, 'Invalid GASP initial response'],
      [{ UTXOList: [{ txid, outputIndex: 0, score: -1 }], since: 0 }, 'score'],
      [{ UTXOList: [{ txid, outputIndex: 0, score: 0 }, { txid, outputIndex: 0, score: 0 }], since: 0 }, 'duplicate'],
      [{ UTXOList: Array.from({ length: 11 }, (_, outputIndex) => ({ txid: outputIndex.toString(16).padStart(64, '0'), outputIndex, score: 0 })), since: 0 }, 'Invalid GASP initial response']
    ])('rejects malformed or over-limit initial responses', async (response, message) => {
      fetchImpl.mockResolvedValue(jsonResponse(response))

      await expect(overlayRemote.getInitialResponse(request)).rejects.toThrow(message)
    })

    it('rejects a declared oversized response before reading its body', async () => {
      const cancel = jest.fn().mockResolvedValue(undefined)
      const response = {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(64 * 1024 * 1024 + 1) }),
        body: { cancel }
      } as unknown as Response
      fetchImpl.mockResolvedValue(response)

      await expect(overlayRemote.getInitialResponse(request)).rejects.toThrow('exceeds')
      expect(cancel).toHaveBeenCalled()
    })
  })

  describe('requestNode', () => {
    const validNode: GASPNode = {
      graphID,
      rawTx,
      outputIndex: 0,
      inputs: {}
    }

    it('returns a transaction-bound node', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(validNode))

      await expect(overlayRemote.requestNode(graphID, txid, 0, true)).resolves.toEqual(validNode)
      expect(fetchImpl).toHaveBeenCalledWith('https://peer.example/requestForeignGASPNode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BSV-Topic': 'tm_test' },
        body: JSON.stringify({ graphID, txid, outputIndex: 0, metadata: true })
      })
    })

    it.each([
      [{ ...validNode, graphID: `${'11'.repeat(32)}.0` }, 'graphID does not match'],
      [{ ...validNode, outputIndex: 1 }, 'outputIndex does not match'],
      [{ ...validNode, rawTx: '02000000000000000000' }, 'does not match the requested txid'],
      [{ ...validNode, inputs: { '__proto__.0': { hash: '00'.repeat(32) } } }, 'input outpoint']
    ])('rejects uncorrelated or malformed node responses', async (response, message) => {
      fetchImpl.mockResolvedValue(jsonResponse(response))

      await expect(overlayRemote.requestNode(graphID, txid, 0, true)).rejects.toThrow(message)
    })
  })
})
