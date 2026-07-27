import { jest } from '@jest/globals'
import * as Utils from '../../../primitives/utils.js'
import { AuthFetch } from '../AuthFetch.js'
import { Peer } from '../../Peer.js'
import { SimplifiedFetchTransport } from '../../transports/SimplifiedFetchTransport.js'
import { getVerifiableCertificates } from '../../utils/index.js'

jest.mock('../../Peer.js', () => ({
  Peer: jest.fn()
}))

jest.mock('../../transports/SimplifiedFetchTransport.js', () => ({
  SimplifiedFetchTransport: jest.fn()
}))

jest.mock('../../utils/index.js', () => ({
  getVerifiableCertificates: jest.fn()
}))

jest.mock('../../../primitives/Random.js', () => ({
  __esModule: true,
  default: jest.fn(() => new Array(32).fill(7))
}))

const PeerMock = Peer as unknown as jest.Mock
const SimplifiedFetchTransportMock = SimplifiedFetchTransport as unknown as jest.Mock
const getVerifiableCertificatesMock = getVerifiableCertificates as jest.MockedFunction<
  typeof getVerifiableCertificates
>

function buildResponsePayload(
  requestNonce: number[],
  status: number,
  headers: Record<string, string>,
  body: number[]
): number[] {
  const writer = new Utils.Writer()
  writer.write(requestNonce)
  writer.writeVarIntNum(status)
  writer.writeVarIntNum(Object.keys(headers).length)

  for (const [key, value] of Object.entries(headers)) {
    const keyBytes = Utils.toArray(key, 'utf8')
    const valueBytes = Utils.toArray(value, 'utf8')
    writer.writeVarIntNum(keyBytes.length)
    writer.write(keyBytes)
    writer.writeVarIntNum(valueBytes.length)
    writer.write(valueBytes)
  }

  writer.writeVarIntNum(body.length)
  writer.write(body)
  return writer.toArray()
}

beforeEach(() => {
  // AuthFetch registers an error listener on every transport it creates.
  SimplifiedFetchTransportMock.mockImplementation(() => ({
    onDataError: jest.fn()
  }))
})

afterEach(() => {
  jest.restoreAllMocks()
  PeerMock.mockReset()
  SimplifiedFetchTransportMock.mockReset()
  getVerifiableCertificatesMock.mockReset()
})

describe('AuthFetch authenticated peer lifecycle', () => {
  test('creates a peer, exchanges certificates, and resolves an authenticated response', async () => {
    let certificatesReceived:
      ((senderPublicKey: string, certificates: Array<{ serialNumber: string }>) => void) | undefined
    let certificatesRequested:
      | ((verifier: string, requestedCertificates: Record<string, unknown>) => Promise<void>)
      | undefined
    let generalMessage: ((senderPublicKey: string, payload: number[]) => void) | undefined

    const stopListeningForGeneralMessages = jest.fn()
    const sendCertificateResponse = jest.fn(async () => {})
    const responseBody = Utils.toArray('authenticated response', 'utf8')
    const peer = {
      ready: Promise.resolve(),
      listenForCertificatesReceived: jest.fn((listener: typeof certificatesReceived) => {
        certificatesReceived = listener
      }),
      listenForCertificatesRequested: jest.fn((listener: typeof certificatesRequested) => {
        certificatesRequested = listener
      }),
      listenForGeneralMessages: jest.fn((listener: typeof generalMessage) => {
        generalMessage = listener
        return 19
      }),
      stopListeningForGeneralMessages,
      sendCertificateResponse,
      toPeer: jest.fn(async () => {
        generalMessage?.(
          'unrelated-server',
          buildResponsePayload(new Array(32).fill(8), 500, {}, [])
        )
        generalMessage?.(
          'server-identity-key',
          buildResponsePayload(
            new Array(32).fill(7),
            201,
            { 'content-type': 'text/plain', 'x-test': 'passed' },
            responseBody
          )
        )
      })
    }

    PeerMock.mockImplementation(() => peer)
    const requestedCertificates = {
      certifiers: ['certifier'],
      types: { identity: ['name'] }
    }
    const wallet = { getPublicKey: jest.fn() }
    const authFetch = new AuthFetch(
      wallet as any,
      requestedCertificates as any,
      undefined,
      'app.example' as any
    )
    jest.spyOn(authFetch as any, 'wait').mockResolvedValue(undefined)

    const response = await authFetch.fetch('https://service.example/resource?mode=full', {
      method: 'POST',
      headers: { 'x-bsv-request': 'test' },
      body: [1, 2, 3]
    })

    expect(SimplifiedFetchTransportMock).toHaveBeenCalledWith('https://service.example')
    expect(PeerMock).toHaveBeenCalledWith(
      wallet,
      expect.anything(),
      requestedCertificates,
      expect.anything(),
      undefined,
      'app.example'
    )
    expect(response.status).toBe(201)
    expect(response.headers.get('x-test')).toBe('passed')
    expect(response.headers.get('x-bsv-auth-identity-key')).toBe('server-identity-key')
    await expect(response.text()).resolves.toBe('authenticated response')
    expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(19)
    expect(authFetch.peers['https://service.example']).toMatchObject({
      identityKey: 'server-identity-key',
      supportsMutualAuth: true
    })

    peer.toPeer.mockImplementationOnce(async () => {
      generalMessage?.(
        'server-identity-key',
        buildResponsePayload(new Array(32).fill(7), 204, {}, [])
      )
    })
    const emptyResponse = await authFetch.fetch('https://service.example/empty')
    expect(emptyResponse.status).toBe(204)
    await expect(emptyResponse.text()).resolves.toBe('')

    certificatesReceived?.('server-identity-key', [{ serialNumber: 'received-certificate' }])
    expect(authFetch.consumeReceivedCertificates()).toEqual([
      { serialNumber: 'received-certificate' }
    ])

    const certificateToSend = { serialNumber: 'certificate-to-send' }
    getVerifiableCertificatesMock.mockResolvedValue([certificateToSend] as any)
    await certificatesRequested?.('server-identity-key', requestedCertificates)
    expect(getVerifiableCertificatesMock).toHaveBeenCalledWith(
      wallet,
      requestedCertificates,
      'server-identity-key',
      'app.example'
    )
    expect(sendCertificateResponse).toHaveBeenCalledWith('server-identity-key', [certificateToSend])

    getVerifiableCertificatesMock.mockResolvedValue([])
    await certificatesRequested?.('server-identity-key', requestedCertificates)
    expect(sendCertificateResponse).toHaveBeenCalledTimes(1)
    expect(authFetch.peers['https://service.example'].pendingCertificateRequests).toEqual([])
  })

  test('waits for pending certificate decisions before sending', async () => {
    const authFetch = new AuthFetch({} as any)
    const peer = {
      listenForGeneralMessages: jest.fn(() => 1),
      toPeer: jest.fn(async () => {
        throw new Error('stop after certificate wait')
      }),
      pendingCertificateRequests: [true]
    }
    ;(authFetch as any).peers['https://service.example'] = {
      peer,
      pendingCertificateRequests: peer.pendingCertificateRequests
    }
    const waitForPending = jest
      .spyOn(authFetch as any, 'waitForPendingCertificateRequests')
      .mockResolvedValue(undefined)

    await expect(authFetch.fetch('https://service.example/resource')).rejects.toThrow(
      'stop after certificate wait'
    )
    expect(waitForPending).toHaveBeenCalledWith((authFetch as any).peers['https://service.example'])
    expect(peer.toPeer).toHaveBeenCalledTimes(1)
  })

  test('retries stale sessions and resolves the recursive response', async () => {
    const authFetch = new AuthFetch({} as any)
    ;(authFetch as any).peers['https://service.example'] = {
      peer: {
        listenForGeneralMessages: jest.fn(() => 1),
        toPeer: jest.fn(async () => {
          throw new Error('Session not found for nonce expired')
        })
      },
      identityKey: 'stale-server-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }

    const originalFetch = authFetch.fetch.bind(authFetch)
    const recoveredResponse = new Response('recovered', { status: 200 })
    const fetchSpy = jest.spyOn(authFetch, 'fetch')
    fetchSpy
      .mockImplementationOnce((url, config) => originalFetch(url, config))
      .mockResolvedValueOnce(recoveredResponse)

    await expect(
      authFetch.fetch('https://service.example/resource', { retryCounter: 2 })
    ).resolves.toBe(recoveredResponse)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(authFetch.peers['https://service.example']).toBeUndefined()
  })

  test('refreshes authenticated sessions rejected with HTTP 401 details', async () => {
    const authFetch = new AuthFetch({} as any)
    const staleError = Object.assign(
      new Error('request arrived without valid BSV authentication'),
      { details: { status: 401 } }
    )
    ;(authFetch as any).peers['https://service.example'] = {
      peer: {
        listenForGeneralMessages: jest.fn(() => 1),
        toPeer: jest.fn(async () => {
          throw staleError
        })
      },
      identityKey: 'stale-server-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }

    const originalFetch = authFetch.fetch.bind(authFetch)
    const recoveredResponse = new Response('recovered', { status: 200 })
    const fetchSpy = jest.spyOn(authFetch, 'fetch')
    fetchSpy
      .mockImplementationOnce((url, config) => originalFetch(url, config))
      .mockResolvedValueOnce(recoveredResponse)

    await expect(authFetch.fetch('https://service.example/resource')).resolves.toBe(
      recoveredResponse
    )
    expect(fetchSpy.mock.calls[1]?.[1]?.retryCounter).toBe(3)
    expect(authFetch.peers['https://service.example']).toBeUndefined()
  })

  test('falls back to validated HTTP after peer authentication failure', async () => {
    const authFetch = new AuthFetch({} as any)
    ;(authFetch as any).peers['https://service.example'] = {
      peer: {
        listenForGeneralMessages: jest.fn(() => 1),
        toPeer: jest.fn(async () => {
          throw new Error('HTTP server failed to authenticate')
        })
      },
      pendingCertificateRequests: []
    }
    const fallbackResponse = new Response('fallback', { status: 200 })
    const fallback = jest
      .spyOn(authFetch as any, 'handleFetchAndValidate')
      .mockResolvedValue(fallbackResponse)

    await expect(authFetch.fetch('https://service.example/resource')).resolves.toBe(
      fallbackResponse
    )
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  test('propagates both validated HTTP and unrelated peer failures', async () => {
    const authFetch = new AuthFetch({} as any)
    const toPeer = jest.fn()
    ;(authFetch as any).peers['https://service.example'] = {
      peer: {
        listenForGeneralMessages: jest.fn(() => 1),
        toPeer
      },
      pendingCertificateRequests: []
    }
    jest
      .spyOn(authFetch as any, 'handleFetchAndValidate')
      .mockRejectedValue(new Error('validated fallback failed'))

    toPeer.mockRejectedValueOnce(new Error('HTTP server failed to authenticate'))
    await expect(authFetch.fetch('https://service.example/first')).rejects.toThrow(
      'validated fallback failed'
    )

    toPeer.mockRejectedValueOnce(new Error('peer transport failed'))
    await expect(authFetch.fetch('https://service.example/second')).rejects.toThrow(
      'peer transport failed'
    )
  })

  test('rejects the pending request when its response cannot be processed', async () => {
    let reportDataError: ((error: Error, message: any) => void) | undefined

    SimplifiedFetchTransportMock.mockImplementation(() => ({
      onDataError: (listener: (error: Error, message: any) => void) => {
        reportDataError = listener
      }
    }))

    const peer = {
      ready: Promise.resolve(),
      listenForCertificatesReceived: jest.fn(),
      listenForCertificatesRequested: jest.fn(),
      listenForGeneralMessages: jest.fn(() => 23),
      stopListeningForGeneralMessages: jest.fn(),
      toPeer: jest.fn(async () => {
        // The HTTP exchange succeeded; the peer then failed to process the
        // response it carried — for instance because the server replied on a
        // session this client does not hold.
        reportDataError?.(new Error('Session not found for nonce: other-session'), {
          version: '0.1',
          messageType: 'general',
          identityKey: 'server-identity-key',
          payload: buildResponsePayload(new Array(32).fill(7), 200, {}, [])
        })
      })
    }
    PeerMock.mockImplementation(() => peer)

    const authFetch = new AuthFetch({ getPublicKey: jest.fn() } as any)

    await expect(authFetch.fetch('https://service.example/resource')).rejects.toThrow(
      'Session not found for nonce: other-session'
    )
  })

  test('leaves other pending requests alone when one response fails', async () => {
    let reportDataError: ((error: Error, message: any) => void) | undefined
    let generalMessage: ((senderPublicKey: string, payload: number[]) => void) | undefined

    SimplifiedFetchTransportMock.mockImplementation(() => ({
      onDataError: (listener: (error: Error, message: any) => void) => {
        reportDataError = listener
      }
    }))

    const peer = {
      ready: Promise.resolve(),
      listenForCertificatesReceived: jest.fn(),
      listenForCertificatesRequested: jest.fn(),
      listenForGeneralMessages: jest.fn((listener: typeof generalMessage) => {
        generalMessage = listener
        return 24
      }),
      stopListeningForGeneralMessages: jest.fn(),
      toPeer: jest.fn(async () => {
        // A failure carrying a different request nonce must not settle this one.
        reportDataError?.(new Error('Session not found for nonce: other-session'), {
          version: '0.1',
          messageType: 'general',
          identityKey: 'server-identity-key',
          payload: buildResponsePayload(new Array(32).fill(8), 200, {}, [])
        })
        generalMessage?.(
          'server-identity-key',
          buildResponsePayload(new Array(32).fill(7), 200, {}, [])
        )
      })
    }
    PeerMock.mockImplementation(() => peer)

    const authFetch = new AuthFetch({ getPublicKey: jest.fn() } as any)

    const response = await authFetch.fetch('https://service.example/resource')
    expect(response.status).toBe(200)
  })
})
