import { jest } from '@jest/globals'
import { PrivateKey, Utils } from '../../../primitives/index.js'

// Register for both the ordinary Jest transform and native ESM mutation runner.
jest.mock('../../Peer.js', () => ({ Peer: jest.fn() }))
jest.unstable_mockModule('../../Peer.js', () => ({ Peer: jest.fn() }))
let AuthFetch: typeof import('../AuthFetch.js').AuthFetch
let PeerMock: jest.Mock
beforeAll(async () => {
  ;({ AuthFetch } = await import('../AuthFetch.js'))
  PeerMock = (await import('../../Peer.js')).Peer as unknown as jest.Mock
})
const url = 'https://service.example/overlay/v1/lookup/read'
const identity = new PrivateKey(43).toPublicKey().toString()

function responsePayload(nonce: number[]): number[] {
  const writer = new Utils.Writer()
  writer.write(nonce)
  writer.writeVarIntNum(402)
  writer.writeVarIntNum(0)
  const body = Utils.toArray('Payment requested', 'utf8')
  writer.writeVarIntNum(body.length)
  writer.write(body)
  return writer.toArray()
}

function peer(outcomes: Array<'response' | 'stale'>) {
  let listener: ((sender: string, payload: number[]) => void) | undefined
  return {
    ready: Promise.resolve(),
    listenForCertificatesReceived: jest.fn(),
    listenForCertificatesRequested: jest.fn(),
    listenForGeneralMessages: jest.fn((callback: typeof listener) => {
      listener = callback
      return 1
    }),
    stopListeningForGeneralMessages: jest.fn(),
    toPeer: jest.fn(async (payload: number[]) => {
      if (outcomes.shift() === 'stale') throw new Error('Session not found for nonce')
      listener?.(identity, responsePayload(payload.slice(0, 32)))
    })
  }
}

function client() {
  const wallet = {
    createAction: jest.fn(async () => {
      throw new Error('Unexpected payment')
    })
  }
  const fetcher = new AuthFetch(wallet as never)
  return { wallet, fetcher }
}

afterEach(() => {
  jest.restoreAllMocks()
  PeerMock.mockReset()
})

describe('AuthFetch explicit automatic-payment policy', () => {
  test.each([false, true])(
    'returns 402 without payment through the %s authenticated-recovery path',
    async recover => {
      const { wallet, fetcher } = client()
      const outcomes: Array<'response' | 'stale'> = recover ? ['stale', 'response'] : ['response']
      const first = peer(outcomes)
      fetcher.peers[new URL(url).origin] = {
        peer: first as never,
        identityKey: identity,
        supportsMutualAuth: true,
        pendingCertificateRequests: []
      }
      PeerMock.mockImplementation(() => peer(outcomes))
      const payment = jest.spyOn(fetcher as never, 'handlePaymentAndRetry' as never)
      const options = { allowPayments: false, retryCounter: 3 }
      const pending = fetcher.fetch(url, options)
      options.allowPayments = true
      const result = await pending
      expect(result.status).toBe(402)
      expect(await result.text()).toBe('Payment requested')
      expect(payment).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
      expect(PeerMock).toHaveBeenCalledTimes(recover ? 1 : 0)
    }
  )

  test('preserves ordinary HTTP failure behavior without authorizing payment', async () => {
    const wallet = { createAction: jest.fn() }
    let finish!: (response: Response) => void
    const response = new Promise<Response>(resolve => {
      finish = resolve
    })
    const fetchClient = jest.fn<typeof fetch>(async () => await response)
    const fetcher = new AuthFetch(wallet as never, undefined, undefined, undefined, {}, fetchClient)
    fetcher.peers[new URL(url).origin] = {
      peer: {} as never,
      supportsMutualAuth: false,
      pendingCertificateRequests: []
    }
    const options = { allowPayments: false }
    const pending = fetcher.fetch(url, options)
    options.allowPayments = true
    finish(new Response('Payment requested', { status: 402 }))
    await expect(pending).rejects.toThrow('status: 402')
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(fetchClient).toHaveBeenCalledTimes(1)
  })

  test.each([undefined, true])(
    'retains the existing automatic-payment dispatch when allowPayments is %s',
    async allowPayments => {
      const { fetcher } = client()
      fetcher.peers[new URL(url).origin] = {
        peer: peer(['response']) as never,
        identityKey: identity,
        supportsMutualAuth: true,
        pendingCertificateRequests: []
      }
      const payment = jest
        .spyOn(fetcher as never, 'handlePaymentAndRetry' as never)
        .mockResolvedValue(new Response('paid', { status: 200 }) as never)
      expect((await fetcher.fetch(url, { allowPayments })).status).toBe(200)
      expect(payment).toHaveBeenCalledTimes(1)
    }
  )

  test.each([null, 0, 1, 'false', {}])(
    'rejects a non-boolean opt-out before peer or wallet activity: %s',
    async allowPayments => {
      const { wallet, fetcher } = client()
      await expect(fetcher.fetch(url, { allowPayments } as never)).rejects.toThrow('boolean')
      expect(PeerMock).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    }
  )
})
