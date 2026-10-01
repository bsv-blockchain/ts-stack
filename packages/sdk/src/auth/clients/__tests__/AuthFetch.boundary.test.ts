import { jest } from '@jest/globals'

import * as Utils from '../../../primitives/utils.js'
import PrivateKey from '../../../primitives/PrivateKey.js'
import { ProtoWallet } from '../../../wallet/ProtoWallet.js'
import { Peer } from '../../Peer.js'
import { SessionManager } from '../../SessionManager.js'
import { AuthMessage, PeerSession, Transport } from '../../types.js'
import { AuthFetch } from '../AuthFetch.js'

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

function parseAuthenticatedResponse(
  authFetch: AuthFetch,
  nonce: number[],
  payload: number[],
  sender = 'server-identity-key'
): Response | undefined {
  return (authFetch as any).parseAuthenticatedResponse(
    'https://service.example',
    Utils.toBase64(nonce),
    sender,
    payload
  )
}

describe('AuthFetch authenticated response framing', () => {
  const nonce = Array.from({ length: 32 }, (_, index) => index)

  test('accepts both status endpoints, exact-size bodies, and absent peer state', async () => {
    const authFetch = new AuthFetch({} as never, undefined, undefined, undefined, {
      maxResponseBytes: 4
    })
    const lower = parseAuthenticatedResponse(
      authFetch,
      nonce,
      buildResponsePayload(nonce, 200, { 'x-answer': 'yes' }, [1, 2, 3, 4])
    )!
    expect(lower.status).toBe(200)
    expect(lower.statusText).toBe('200')
    expect(lower.headers.get('x-answer')).toBe('yes')
    expect(lower.headers.get('x-bsv-auth-identity-key')).toBe('server-identity-key')
    await expect(lower.arrayBuffer()).resolves.toEqual(Uint8Array.of(1, 2, 3, 4).buffer)

    const upper = parseAuthenticatedResponse(
      authFetch,
      nonce,
      buildResponsePayload(nonce, 599, {}, [])
    )!
    expect(upper.status).toBe(599)
    await expect(upper.text()).resolves.toBe('')
  })

  test.each([199, 600])('rejects out-of-range HTTP status %i', status => {
    const authFetch = new AuthFetch({} as never)
    expect(() =>
      parseAuthenticatedResponse(authFetch, nonce, buildResponsePayload(nonce, status, {}, []))
    ).toThrow('Authenticated response contains an invalid HTTP status code.')
  })

  test('ignores another request nonce without mutating the peer identity', () => {
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer: {},
      identityKey: 'original',
      supportsMutualAuth: false,
      pendingCertificateRequests: []
    }
    const otherNonce = nonce.map(value => value ^ 0xff)
    expect(
      parseAuthenticatedResponse(
        authFetch,
        nonce,
        buildResponsePayload(otherNonce, 200, {}, []),
        'substituted'
      )
    ).toBeUndefined()
    expect(authFetch.peers['https://service.example']).toMatchObject({
      identityKey: 'original',
      supportsMutualAuth: false
    })
  })

  test('updates the authenticated identity only after the nonce matches', () => {
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer: {},
      pendingCertificateRequests: []
    }
    parseAuthenticatedResponse(
      authFetch,
      nonce,
      buildResponsePayload(nonce, 204, {}, []),
      'authenticated-server'
    )
    expect(authFetch.peers['https://service.example']).toMatchObject({
      identityKey: 'authenticated-server',
      supportsMutualAuth: true
    })
  })

  test('enforces the frame ceiling before parsing and permits its exact endpoint', () => {
    const authFetch = new AuthFetch({} as never, undefined, undefined, undefined, {
      maxResponseBytes: 4
    })
    const maximumFrameBytes = 4 + 512 * 1024
    const atLimit = buildResponsePayload(nonce, 200, {}, [])
    while (atLimit.length < maximumFrameBytes) atLimit.push(0)
    expect(() => parseAuthenticatedResponse(authFetch, nonce, atLimit)).toThrow(
      'Authenticated response contains trailing bytes.'
    )
    expect(() => parseAuthenticatedResponse(authFetch, nonce, [...atLimit, 0])).toThrow(
      'Authenticated response frame exceeds the configured limit.'
    )
  })

  test.each([
    ['empty name', '', '', 'invalid response header name length'],
    ['oversized name', 'k'.repeat(1025), '', 'invalid response header name length'],
    ['oversized value', 'key', 'v'.repeat(32 * 1024 + 1), 'invalid response header value length']
  ])('rejects an %s', (_case, key, value, message) => {
    const authFetch = new AuthFetch({} as never)
    expect(() =>
      parseAuthenticatedResponse(
        authFetch,
        nonce,
        buildResponsePayload(nonce, 200, { [key]: value }, [])
      )
    ).toThrow(`Authenticated response contains an ${message}.`)
  })

  test('enforces the aggregate header byte ceiling', () => {
    const authFetch = new AuthFetch({} as never)
    const headers = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`x-${index}`, 'v'.repeat(32 * 1024)])
    )
    expect(() =>
      parseAuthenticatedResponse(authFetch, nonce, buildResponsePayload(nonce, 200, headers, []))
    ).toThrow('Authenticated response headers exceed the configured limit.')
  })

  test('rejects a declared body above the configured ceiling before reading it', () => {
    const authFetch = new AuthFetch({} as never, undefined, undefined, undefined, {
      maxResponseBytes: 4
    })
    const writer = new Utils.Writer()
    writer.write(nonce)
    writer.writeVarIntNum(200)
    writer.writeVarIntNum(0)
    writer.writeVarIntNum(5)
    expect(() => parseAuthenticatedResponse(authFetch, nonce, writer.toArray())).toThrow(
      'Authenticated response body exceeds the configured limit.'
    )
  })

  test('classifies stale-session errors only with their complete authenticated context', () => {
    const authFetch = new AuthFetch({} as never)
    const classify = (error: unknown, identityKey?: string): boolean =>
      (authFetch as any).isStaleSessionError(error, {
        identityKey,
        peer: {},
        pendingCertificateRequests: []
      })
    expect(classify('Session not found for nonce')).toBe(false)
    expect(classify(new Error('Session not found for nonce expired'))).toBe(true)
    const unauthenticated = (status?: number): Error =>
      Object.assign(new Error('response arrived without valid BSV authentication'), {
        details: status === undefined ? undefined : { status }
      })
    expect(classify(unauthenticated(401))).toBe(false)
    expect(classify(unauthenticated(), 'server')).toBe(false)
    expect(classify(unauthenticated(403), 'server')).toBe(false)
    expect(classify(unauthenticated(401), 'server')).toBe(true)
    expect(classify(new Error('unrelated'), 'server')).toBe(false)
  })
})

describe('AuthFetch pending-request boundary', () => {
  test('cleans request state when an authenticated response payload is malformed', async () => {
    let generalMessage: ((senderPublicKey: string, payload: number[]) => void) | undefined
    const stopListeningForGeneralMessages = jest.fn()
    const peer = {
      listenForGeneralMessages: jest.fn(listener => {
        generalMessage = listener
        return 41
      }),
      stopListeningForGeneralMessages,
      toPeer: jest.fn(async (payload: number[]) => {
        const malformedResponse = new Utils.Writer()
        malformedResponse.write(payload.slice(0, 32))
        malformedResponse.writeVarIntNum(999)
        generalMessage?.('server-identity-key', malformedResponse.toArray())
      })
    }
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer,
      identityKey: 'server-identity-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }

    await expect(authFetch.fetch('https://service.example/resource')).rejects.toThrow()
    expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(41)
    expect((authFetch as any).pendingRequestNonces.size).toBe(0)
  })

  test.each([
    [
      'excessive header count',
      (nonce: number[]) => {
        const writer = new Utils.Writer()
        writer.write(nonce)
        writer.writeVarIntNum(200)
        writer.writeVarIntNum(1_000_000)
        return writer.toArray()
      },
      'invalid response header count'
    ],
    [
      'truncated body',
      (nonce: number[]) => {
        const writer = new Utils.Writer()
        writer.write(nonce)
        writer.writeVarIntNum(200)
        writer.writeVarIntNum(0)
        writer.writeVarIntNum(5)
        writer.write([1])
        return writer.toArray()
      },
      'truncated while reading response body'
    ],
    [
      'trailing data',
      (nonce: number[]) => {
        const writer = new Utils.Writer()
        writer.write(nonce)
        writer.writeVarIntNum(200)
        writer.writeVarIntNum(0)
        writer.writeVarIntNum(-1)
        writer.write([1])
        return writer.toArray()
      },
      'trailing bytes'
    ]
  ])('rejects a malicious authenticated response with %s', async (_case, build, message) => {
    let generalMessage: ((senderPublicKey: string, payload: number[]) => void) | undefined
    const peer = {
      listenForGeneralMessages: jest.fn(listener => {
        generalMessage = listener
        return 51
      }),
      stopListeningForGeneralMessages: jest.fn(),
      toPeer: jest.fn(async (payload: number[]) => {
        generalMessage?.('server-identity-key', build(payload.slice(0, 32)))
      })
    }
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer,
      identityKey: 'server-identity-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }

    await expect(authFetch.fetch('https://service.example/resource')).rejects.toThrow(message)
    expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledWith(51)
    expect((authFetch as any).pendingRequestNonces.size).toBe(0)
  })

  test('times out and cleans an authenticated request with no response', async () => {
    jest.useFakeTimers()
    try {
      const stopListeningForGeneralMessages = jest.fn()
      const authFetch = new AuthFetch({} as never)
      ;(authFetch as any).peers['https://service.example'] = {
        peer: {
          listenForGeneralMessages: jest.fn(() => 42),
          stopListeningForGeneralMessages,
          toPeer: jest.fn(async () => {})
        },
        identityKey: 'server-identity-key',
        supportsMutualAuth: true,
        pendingCertificateRequests: []
      }

      const request = authFetch.fetch('https://service.example/resource')
      const rejection = expect(request).rejects.toThrow(
        'Timed out waiting for authenticated response.'
      )
      await jest.advanceTimersByTimeAsync(30000)

      await rejection
      expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(42)
      expect((authFetch as any).pendingRequestNonces.size).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test('fails before allocating a listener when authenticated request capacity is exhausted', async () => {
    const listenForGeneralMessages = jest.fn()
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).pendingRequestNonces = new Set(
      Array.from({ length: 1000 }, (_, index) => String(index))
    )
    ;(authFetch as any).peers['https://service.example'] = {
      peer: { listenForGeneralMessages, toPeer: jest.fn() },
      identityKey: 'server-identity-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }

    await expect(authFetch.fetch('https://service.example/resource')).rejects.toThrow(
      'Authentication request capacity exceeded.'
    )
    expect(listenForGeneralMessages).not.toHaveBeenCalled()
  })

  test('settles once, clears its timer, and removes exactly one listener', async () => {
    jest.useFakeTimers()
    try {
      let generalMessage: ((senderPublicKey: string, payload: number[]) => void) | undefined
      const stopListeningForGeneralMessages = jest.fn()
      const body = Utils.toArray('first response', 'utf8')
      const peer = {
        listenForGeneralMessages: jest.fn(listener => {
          generalMessage = listener
          return 44
        }),
        stopListeningForGeneralMessages,
        toPeer: jest.fn(async (payload: number[]) => {
          generalMessage?.(
            'server-identity-key',
            buildResponsePayload(payload.slice(0, 32), 201, { 'x-result': 'first' }, body)
          )
          generalMessage?.(
            'server-identity-key',
            buildResponsePayload(payload.slice(0, 32), 202, { 'x-result': 'second' }, [])
          )
          throw new Error('late transport failure')
        })
      }
      const authFetch = new AuthFetch({} as never)
      ;(authFetch as any).peers['https://service.example'] = {
        peer,
        identityKey: 'server-identity-key',
        supportsMutualAuth: true,
        pendingCertificateRequests: []
      }
      const waitForPending = jest.spyOn(authFetch as any, 'waitForPendingCertificateRequests')

      const response = await authFetch.fetch('https://service.example/resource')

      expect(response.status).toBe(201)
      expect(response.headers.get('x-result')).toBe('first')
      await expect(response.text()).resolves.toBe('first response')
      expect(stopListeningForGeneralMessages).toHaveBeenCalledTimes(1)
      expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(44)
      expect(waitForPending).not.toHaveBeenCalled()
      expect((authFetch as any).pendingRequestNonces.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test('cleans state when pending certificate work rejects before send', async () => {
    jest.useFakeTimers()
    try {
      const stopListeningForGeneralMessages = jest.fn()
      const peer = {
        listenForGeneralMessages: jest.fn(() => 45),
        stopListeningForGeneralMessages,
        toPeer: jest.fn()
      }
      const authFetch = new AuthFetch({} as never)
      ;(authFetch as any).peers['https://service.example'] = {
        peer,
        identityKey: 'server-identity-key',
        supportsMutualAuth: true,
        pendingCertificateRequests: [true]
      }
      jest
        .spyOn(authFetch as any, 'waitForPendingCertificateRequests')
        .mockRejectedValue(new Error('certificate rejected'))

      await expect(authFetch.fetch('https://service.example/resource')).rejects.toThrow(
        'certificate rejected'
      )
      expect(peer.toPeer).not.toHaveBeenCalled()
      expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(45)
      expect((authFetch as any).pendingRequestNonces.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test('cleans a settled request when the peer has no listener-removal API', async () => {
    let generalMessage: ((senderPublicKey: string, payload: number[]) => void) | undefined
    const peer = {
      listenForGeneralMessages: jest.fn(listener => {
        generalMessage = listener
        return undefined
      }),
      toPeer: jest.fn(async (payload: number[]) => {
        generalMessage?.(
          'server-identity-key',
          buildResponsePayload(payload.slice(0, 32), 204, {}, [])
        )
      })
    }
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer,
      identityKey: 'server-identity-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }

    await expect(authFetch.fetch('https://service.example/resource')).resolves.toMatchObject({
      status: 204
    })
    expect((authFetch as any).pendingRequestNonces.size).toBe(0)
  })

  test('does not remove a listener when the peer returns no listener ID', async () => {
    let generalMessage: ((senderPublicKey: string, payload: number[]) => void) | undefined
    const stopListeningForGeneralMessages = jest.fn()
    const peer = {
      listenForGeneralMessages: jest.fn(listener => {
        generalMessage = listener
        return undefined
      }),
      stopListeningForGeneralMessages,
      toPeer: jest.fn(async (payload: number[]) => {
        generalMessage?.(
          'server-identity-key',
          buildResponsePayload(payload.slice(0, 32), 204, {}, [])
        )
      })
    }
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer,
      identityKey: 'server-identity-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }

    await expect(authFetch.fetch('https://service.example/resource')).resolves.toMatchObject({
      status: 204
    })
    expect(stopListeningForGeneralMessages).not.toHaveBeenCalled()
  })

  test.each([
    new Error('Session not found for nonce expired'),
    Object.assign(new Error('response arrived without valid BSV authentication'), {
      details: { status: 401 }
    })
  ])('cleans and retries a stale authenticated session: %s', async transportError => {
    const stopListeningForGeneralMessages = jest.fn()
    const peer = {
      listenForGeneralMessages: jest.fn(() => 46),
      stopListeningForGeneralMessages,
      toPeer: jest.fn(async () => await Promise.reject(transportError))
    }
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer,
      identityKey: 'server-identity-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }
    const originalFetch = authFetch.fetch.bind(authFetch)
    const recursiveResponse = new Response('retried', { status: 200 })
    const fetchSpy = jest
      .spyOn(authFetch, 'fetch')
      .mockImplementationOnce(originalFetch)
      .mockResolvedValueOnce(recursiveResponse)
    const config: any = {}

    await expect(authFetch.fetch('https://service.example/resource', config)).resolves.toBe(
      recursiveResponse
    )
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(config.retryCounter).toBe(3)
    expect(authFetch.peers['https://service.example']).toBeUndefined()
    expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(46)
    expect((authFetch as any).pendingRequestNonces.size).toBe(0)
  })

  test('uses the validated HTTP fallback and cleans state after peer authentication fails', async () => {
    const stopListeningForGeneralMessages = jest.fn()
    const peerState = {
      peer: {
        listenForGeneralMessages: jest.fn(() => 47),
        stopListeningForGeneralMessages,
        toPeer: jest.fn(async () => {
          throw new Error('HTTP server failed to authenticate')
        })
      },
      identityKey: 'server-identity-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = peerState
    const fallback = new Response('fallback', { status: 200 })
    const validate = jest
      .spyOn(authFetch as any, 'handleFetchAndValidate')
      .mockResolvedValue(fallback)

    await expect(authFetch.fetch('https://service.example/resource')).resolves.toBe(fallback)
    expect(validate).toHaveBeenCalledWith(
      'https://service.example/resource',
      expect.any(Object),
      peerState
    )
    expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(47)
    expect((authFetch as any).pendingRequestNonces.size).toBe(0)
  })

  test('rejects with the validated HTTP fallback error and cleans state', async () => {
    const stopListeningForGeneralMessages = jest.fn()
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer: {
        listenForGeneralMessages: jest.fn(() => 48),
        stopListeningForGeneralMessages,
        toPeer: jest.fn(async () => {
          throw new Error('HTTP server failed to authenticate')
        })
      },
      identityKey: 'server-identity-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }
    jest
      .spyOn(authFetch as any, 'handleFetchAndValidate')
      .mockRejectedValue(new Error('fallback rejected'))

    await expect(authFetch.fetch('https://service.example/resource')).rejects.toThrow(
      'fallback rejected'
    )
    expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(48)
    expect((authFetch as any).pendingRequestNonces.size).toBe(0)
  })

  test('rejects non-Error transport failures and cleans state', async () => {
    const stopListeningForGeneralMessages = jest.fn()
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer: {
        listenForGeneralMessages: jest.fn(() => 49),
        stopListeningForGeneralMessages,
        toPeer: jest.fn(async () => await Promise.reject('untrusted rejection'))
      },
      identityKey: 'server-identity-key',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }

    await expect(authFetch.fetch('https://service.example/resource')).rejects.toBe(
      'untrusted rejection'
    )
    expect(stopListeningForGeneralMessages).toHaveBeenCalledWith(49)
    expect((authFetch as any).pendingRequestNonces.size).toBe(0)
  })
})

describe('AuthFetch expired-request dispatch boundary', () => {
  test('does not send after certificate work completes past the response deadline', async () => {
    jest.useFakeTimers()
    try {
      let finishCertificates!: () => void
      const wait = new Promise<void>(resolve => {
        finishCertificates = resolve
      })
      const peer = {
        listenForGeneralMessages: jest.fn(() => 101),
        stopListeningForGeneralMessages: jest.fn(),
        toPeer: jest.fn(async () => {})
      }
      const authFetch = new AuthFetch({} as never)
      ;(authFetch as any).peers['https://service.example'] = {
        peer,
        identityKey: 'server',
        supportsMutualAuth: true,
        pendingCertificateRequests: [true]
      }
      jest.spyOn(authFetch as any, 'waitForPendingCertificateRequests').mockReturnValue(wait)
      const pending = authFetch.fetch('https://service.example/write', {
        method: 'POST',
        body: 'synthetic'
      })
      const rejected = expect(pending).rejects.toThrow(
        'Timed out waiting for authenticated response.'
      )
      await jest.advanceTimersByTimeAsync(30000)
      await rejected
      finishCertificates()
      await jest.advanceTimersByTimeAsync(0)
      expect(peer.toPeer).not.toHaveBeenCalled()
      expect((authFetch as any).pendingRequestNonces.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a late stale-session failure never starts a retry after timeout', async () => {
    jest.useFakeTimers()
    try {
      let failSend!: (error: Error) => void
      const send = new Promise<void>((_resolve, reject) => {
        failSend = reject
      })
      const peer = {
        listenForGeneralMessages: jest.fn(() => 102),
        stopListeningForGeneralMessages: jest.fn(),
        toPeer: jest.fn(() => send)
      }
      const authFetch = new AuthFetch({} as never)
      ;(authFetch as any).peers['https://service.example'] = {
        peer,
        identityKey: 'server',
        supportsMutualAuth: true,
        pendingCertificateRequests: []
      }
      const recover = jest.spyOn(authFetch as any, 'recoverAuthenticatedSend')
      const pending = authFetch.fetch('https://service.example/write', {
        method: 'POST',
        body: 'synthetic'
      })
      const rejected = expect(pending).rejects.toThrow(
        'Timed out waiting for authenticated response.'
      )
      await jest.advanceTimersByTimeAsync(30000)
      await rejected
      failSend(new Error('Session not found for nonce'))
      await jest.advanceTimersByTimeAsync(0)
      expect(peer.toPeer).toHaveBeenCalledTimes(1)
      expect(recover).not.toHaveBeenCalled()
      expect((authFetch as any).pendingRequestNonces.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test('preserves an immediate gateway failure and cleans the waiter without retrying', async () => {
    const failure = Object.assign(new Error('Unauthenticated HTTP 502 response'), {
      details: { status: 502 }
    })
    const peer = {
      listenForGeneralMessages: jest.fn(() => 103),
      stopListeningForGeneralMessages: jest.fn(),
      toPeer: jest.fn(async () => {
        throw failure
      })
    }
    const authFetch = new AuthFetch({} as never)
    ;(authFetch as any).peers['https://service.example'] = {
      peer,
      identityKey: 'server',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }
    await expect(authFetch.fetch('https://service.example/write', { method: 'POST' })).rejects.toBe(
      failure
    )
    expect(peer.toPeer).toHaveBeenCalledTimes(1)
    expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledTimes(1)
    expect((authFetch as any).pendingRequestNonces.size).toBe(0)
  })
})

describe('AuthFetch late wallet approval boundary', () => {
  const unknownOutcome =
    'Timed out waiting for authenticated response. The request was sent; its outcome is unknown.'

  class LocalTransport implements Transport {
    remote?: LocalTransport
    general: AuthMessage[] = []
    holdGeneral?: Promise<void>
    private onDataCallback?: (message: AuthMessage) => Promise<void>

    async send(message: AuthMessage): Promise<void> {
      if (message.messageType === 'general' && this.holdGeneral !== undefined) {
        this.general.push(message)
        return await this.holdGeneral
      }
      if (message.messageType === 'general') this.general.push(message)
      void this.remote?.onDataCallback?.(message).catch(() => {})
    }

    async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
      this.onDataCallback = callback
    }
  }

  class HeldSessions extends SessionManager {
    hold?: Promise<void>

    async updateSession(session: PeerSession): Promise<void> {
      if (this.hold !== undefined) await this.hold
      super.updateSession(session)
    }
  }

  function setup(sessions?: SessionManager): {
    authFetch: AuthFetch
    wallet: ProtoWallet
    client: LocalTransport
  } {
    const client = new LocalTransport()
    const server = new LocalTransport()
    client.remote = server
    server.remote = client
    const serverPeer = new Peer(new ProtoWallet(new PrivateKey(31)), server)
    serverPeer.listenForGeneralMessages((sender, payload) => {
      void serverPeer.toPeer(buildResponsePayload(payload.slice(0, 32), 200, {}, []), sender)
    })
    const wallet = new ProtoWallet(new PrivateKey(32))
    const authFetch = new AuthFetch(wallet)
    ;(authFetch as any).peers['https://service.example'] = {
      peer: new Peer(wallet, client, undefined, sessions),
      identityKey: new PrivateKey(31).toPublicKey().toString(),
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }
    return { authFetch, wallet, client }
  }

  function holdWallet(wallet: ProtoWallet, method: 'createHmac' | 'createSignature'): () => void {
    let approve!: () => void
    const approved = new Promise<void>(resolve => {
      approve = resolve
    })
    const original = (wallet[method] as Function).bind(wallet)
    jest.spyOn(wallet, method).mockImplementation(async (...args: any[]) => {
      await approved
      return original(...args)
    })
    return approve
  }

  async function expireThenApprove(
    authFetch: AuthFetch,
    approve: () => void,
    message: string
  ): Promise<void> {
    const pending = authFetch.fetch('https://service.example/certificate', {
      method: 'POST',
      body: 'synthetic'
    })
    const rejected = expect(pending).rejects.toThrow(message)
    await jest.advanceTimersByTimeAsync(30000)
    await rejected
    approve()
    await jest.advanceTimersByTimeAsync(1000)
  }

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('a handshake approved after the deadline never sends the request', async () => {
    const { authFetch, wallet, client } = setup()
    const approve = holdWallet(wallet, 'createHmac')
    const sign = jest.spyOn(wallet, 'createSignature')
    await expireThenApprove(authFetch, approve, 'Timed out waiting for authenticated response.')
    expect(client.general).toHaveLength(0)
    expect(sign).not.toHaveBeenCalled()
  })

  test('a signature approved after the deadline never sends the request', async () => {
    const { authFetch, wallet, client } = setup()
    const approve = holdWallet(wallet, 'createSignature')
    await expireThenApprove(authFetch, approve, 'Timed out waiting for authenticated response.')
    expect(client.general).toHaveLength(0)
  })

  test('a request already sent at the deadline reports an unknown outcome', async () => {
    const { authFetch, client } = setup()
    let failSend!: (error: Error) => void
    client.holdGeneral = new Promise<void>((_resolve, reject) => {
      failSend = reject
    })
    await expireThenApprove(
      authFetch,
      () => failSend(new Error('Session not found for nonce')),
      unknownOutcome
    )
    expect(client.general).toHaveLength(1)
  })

  test('a session update finishing after the deadline never sends the request', async () => {
    const sessions = new HeldSessions()
    const { authFetch, wallet, client } = setup(sessions)
    let release!: () => void
    const sign = wallet.createSignature.bind(wallet)
    jest.spyOn(wallet, 'createSignature').mockImplementation(async (...args) => {
      sessions.hold = new Promise<void>(resolve => {
        release = resolve
      })
      return await sign(...args)
    })
    await expireThenApprove(
      authFetch,
      () => release(),
      'Timed out waiting for authenticated response.'
    )
    expect(client.general).toHaveLength(0)
  })

  test('a prompt answered in time sends once and resolves', async () => {
    const { authFetch, client } = setup()
    await expect(
      authFetch.fetch('https://service.example/certificate', { method: 'POST', body: 'synthetic' })
    ).resolves.toMatchObject({ status: 200 })
    expect(client.general).toHaveLength(1)
  })

  test('a denied signature still rejects without sending', async () => {
    const { authFetch, wallet, client } = setup()
    const denied = new Error('User denied the signature request')
    jest.spyOn(wallet, 'createSignature').mockRejectedValue(denied)
    await expect(
      authFetch.fetch('https://service.example/certificate', { method: 'POST', body: 'synthetic' })
    ).rejects.toBe(denied)
    expect(client.general).toHaveLength(0)
  })
})
