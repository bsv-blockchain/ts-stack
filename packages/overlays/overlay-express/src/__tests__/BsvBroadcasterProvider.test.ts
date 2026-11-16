import { describe, expect, it, jest } from '@jest/globals'
import { MerklePath } from '@bsv/sdk'
import { BsvBroadcasterProvider } from '../BsvBroadcasterProvider.js'
import OverlayExpress from '../OverlayExpress.js'

const txid = '11'.repeat(32)

function mockTx(toHexEF: () => string = () => 'efhex'): any {
  return { id: () => txid, toHexEF, toHex: () => 'rawhex' }
}

function provider(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
  url = 'https://arcade.example'
): {
  provider: BsvBroadcasterProvider
  fetcher: jest.Mock<(url: string, init?: RequestInit) => Promise<Response>>
} {
  const fetcher = jest.fn(
    async (requestUrl: string, init?: RequestInit) => await respond(requestUrl, init)
  )
  return {
    provider: new BsvBroadcasterProvider(url, { fetch: fetcher as unknown as typeof fetch }),
    fetcher
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

describe('BsvBroadcasterProvider broadcast results', () => {
  it('keeps a path prefix on the base URL and drops its trailing slashes', async () => {
    const { provider: p, fetcher } = provider(
      () => json({ txid, txStatus: 'RECEIVED' }, 202),
      'https://arcade.example/api//'
    )
    await p.broadcast(mockTx())
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://arcade.example/api/tx')
  })

  it('reports an HTTP failure with an empty body by status code and status text', async () => {
    const { provider: p } = provider(
      () => new Response('', { status: 503, statusText: 'Service Unavailable' })
    )
    const result = await p.broadcast(mockTx())
    expect(result).toEqual({
      status: 'error',
      code: '503',
      txid: undefined,
      description: 'Service Unavailable',
      more: { provider: 'Arcade', httpStatus: 503, terminal: false, response: undefined }
    })
  })

  it('describes a 400 by txStatus and extraInfo when the body has no detail', async () => {
    const { provider: p } = provider(() =>
      json({ txStatus: 'REJECTED', extraInfo: 'bad script' }, 400)
    )
    const result = await p.broadcast(mockTx())
    expect(result).toMatchObject({
      status: 'error',
      code: 'REJECTED',
      description: 'REJECTED bad script',
      more: { httpStatus: 400, terminal: true }
    })
    expect(result.status === 'error' && 'competingTxs' in (result.more as object)).toBe(false)
  })

  it('keeps competing txids on an HTTP failure', async () => {
    const competing = '22'.repeat(32)
    const { provider: p } = provider(() =>
      json({ txid, txStatus: 'DOUBLE_SPEND_ATTEMPTED', competingTxs: [competing] }, 409)
    )
    await expect(p.broadcast(mockTx())).resolves.toMatchObject({
      status: 'error',
      code: 'DOUBLE_SPEND_ATTEMPTED',
      txid,
      more: { httpStatus: 409, terminal: true, competingTxs: [competing] }
    })
  })

  it.each([
    ['a status with no extra info', { txStatus: 'REJECTED' }, 'REJECTED'],
    ['a reason', { reason: 'fee too low' }, 'fee too low'],
    ['an error field', { error: 'queue full' }, 'queue full'],
    ['extra info alone', { extraInfo: 'missing inputs' }, 'missing inputs']
  ])('describes an HTTP failure from %s', async (_label, body, description) => {
    const { provider: p } = provider(() => json(body, 400))
    await expect(p.broadcast(mockTx())).resolves.toMatchObject({ status: 'error', description })
  })

  it('treats an orphan reported only in extraInfo as terminal with an UNKNOWN code', async () => {
    const { provider: p } = provider(() => json({ txid, extraInfo: 'orphan transaction' }, 200))
    await expect(p.broadcast(mockTx())).resolves.toMatchObject({
      status: 'error',
      code: 'UNKNOWN',
      txid,
      description: 'orphan transaction',
      more: { terminal: true }
    })
  })

  it('fails an accepted request whose body reports a terminal status', async () => {
    const { provider: p } = provider(() => json({ txStatus: 'REJECTED' }, 200))
    const result = await p.broadcast(mockTx())
    expect(result).toEqual({
      status: 'error',
      code: 'REJECTED',
      txid: undefined,
      description: 'REJECTED',
      more: { provider: 'Arcade', terminal: true, response: { txStatus: 'REJECTED' } }
    })
  })

  it('treats an accepted request with no status as an unknown success status', async () => {
    const { provider: p } = provider(() => new Response('', { status: 202 }))
    await expect(p.broadcast(mockTx())).resolves.toEqual({
      status: 'error',
      code: '500',
      description: 'Arcade returned an unknown success status',
      more: { provider: 'Arcade', terminal: false }
    })
  })

  it('fills in the requested txid when a success omits it', async () => {
    const { provider: p } = provider(() => json({ txStatus: 'SEEN_ON_NETWORK' }))
    await expect(p.broadcast(mockTx())).resolves.toEqual({
      status: 'success',
      txid,
      message: 'SEEN_ON_NETWORK',
      competingTxs: undefined
    })
  })

  it('reports success with extra info', async () => {
    const { provider: p } = provider(() =>
      json({ txid, txStatus: 'ACCEPTED_BY_NETWORK', extraInfo: 'queued' }, 202)
    )
    await expect(p.broadcast(mockTx())).resolves.toMatchObject({
      status: 'success',
      txid,
      message: 'ACCEPTED_BY_NETWORK queued'
    })
  })

  it('treats an accepted body without a status as an unknown success status', async () => {
    const { provider: p } = provider(() => json({ txid }, 202))
    await expect(p.broadcast(mockTx())).resolves.toMatchObject({
      status: 'error',
      code: '500',
      description: 'Arcade returned an unknown success status'
    })
  })

  it('rejects a success body with a fractional status code as malformed', async () => {
    const { provider: p } = provider(() => json({ txid, txStatus: 'RECEIVED', status: 1.5 }))
    await expect(p.broadcast(mockTx())).resolves.toMatchObject({
      status: 'error',
      code: '500',
      description: 'Arcade returned malformed JSON'
    })
  })

  it('reports a thrown non-Error as an internal server error', async () => {
    const { provider: p } = provider(() => {
      throw 'offline'
    })
    await expect(p.broadcast(mockTx())).resolves.toMatchObject({
      status: 'error',
      code: '500',
      description: 'Internal Server Error'
    })
  })
})

describe('BsvBroadcasterProvider transaction encoding', () => {
  it('falls back to raw hex when inputs lack source transactions for EF', async () => {
    const { provider: p, fetcher } = provider(() => json({ txid, txStatus: 'RECEIVED' }, 202))
    await p.broadcast(
      mockTx(() => {
        throw new Error('All inputs must have source transactions when serializing to EF format')
      })
    )
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ rawTx: 'rawhex' })
  })

  it('does not hide any other EF serialization error', async () => {
    const { provider: p, fetcher } = provider(() => json({ txid, txStatus: 'RECEIVED' }, 202))
    await expect(
      p.broadcast(
        mockTx(() => {
          throw new Error('broken input')
        })
      )
    ).rejects.toThrow('broken input')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('constructs with default configuration', () => {
    expect(new BsvBroadcasterProvider('https://arcade.example').name).toBe('Arcade')
  })
})

describe('BsvBroadcasterProvider proofs', () => {
  const merklePath = new MerklePath(7, [[{ offset: 0, txid: true, hash: txid }]])

  it('takes the block height from an IMMUTABLE proof when the response omits it', async () => {
    const { provider: p } = provider(() =>
      json({ txid, txStatus: 'IMMUTABLE', merklePath: merklePath.toHex() })
    )
    await expect(p.fetchMerkleProof(txid)).resolves.toMatchObject({
      txid,
      blockHeight: 7,
      blockHash: undefined,
      merkleRoot: txid
    })
  })

  it('returns no proof for an empty status body', async () => {
    const { provider: p } = provider(() => new Response('', { status: 200 }))
    await expect(p.fetchMerkleProof(txid)).resolves.toBeUndefined()
  })

  it('returns no proof for a mined status without a Merkle path', async () => {
    const { provider: p } = provider(() => json({ txid, txStatus: 'MINED' }))
    await expect(p.fetchMerkleProof(txid)).resolves.toBeUndefined()
  })
})

describe('OverlayExpress BSV Broadcaster wiring', () => {
  const create = (): OverlayExpress =>
    new OverlayExpress('Broadcaster Test', 'private-key', 'overlay.example')

  it('uses BSV Broadcaster as the only propagation provider when it is the only one configured', () => {
    const overlay = create()
    overlay.configureBsvBroadcaster('https://arcade.example')
    const broadcaster = (overlay as any).buildBroadcaster()
    expect(broadcaster).toBeInstanceOf(BsvBroadcasterProvider)
    expect((overlay as any).ensureBsvBroadcasterProvider()).toBe(broadcaster)
  })

  it('creates the proof provider on demand and reuses it', () => {
    const overlay = create()
    expect((overlay as any).ensureBsvBroadcasterProvider()).toBeUndefined()
    overlay.configureBsvBroadcaster('https://arcade.example')
    const first = (overlay as any).ensureBsvBroadcasterProvider()
    expect(first).toBeInstanceOf(BsvBroadcasterProvider)
    expect((overlay as any).ensureBsvBroadcasterProvider()).toBe(first)
  })
})
