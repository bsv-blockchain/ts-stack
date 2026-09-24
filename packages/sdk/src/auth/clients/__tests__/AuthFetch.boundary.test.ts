import { jest } from '@jest/globals'

import * as Utils from '../../../primitives/utils.js'
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
    const maximumFrameBytes = 4 + 128 * 1024
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
    ['oversized name', 'k'.repeat(257), '', 'invalid response header name length'],
    ['oversized value', 'key', 'v'.repeat(8193), 'invalid response header value length']
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
      Array.from({ length: 9 }, (_, index) => [`x-${index}`, 'v'.repeat(8192)])
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

  test.each([
    ['serialization', false],
    ['serialization', true],
    ['certificate wait', false],
    ['certificate wait', true]
  ] as const)(
    'cancellation during %s drains state and preserves existing payment context (%s)',
    async (phase, paid) => {
      const controller = new AbortController()
      const remove = jest.spyOn(controller.signal, 'removeEventListener')
      const peer = {
        listenForGeneralMessages: jest.fn(() => 52),
        stopListeningForGeneralMessages: jest.fn(),
        toPeer: jest.fn()
      }
      const authFetch = new AuthFetch({} as never)
      ;(authFetch as any).peers['https://service.example'] = {
        peer,
        identityKey: 'server-identity-key',
        supportsMutualAuth: true,
        pendingCertificateRequests: phase === 'certificate wait' ? [true] : []
      }
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        entered = resolve
      })
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      if (phase === 'serialization') {
        const serialize = (authFetch as any).serializeRequest.bind(authFetch)
        jest
          .spyOn(authFetch as any, 'serializeRequest')
          .mockImplementation(async (...args: unknown[]) => {
            const result = await serialize(...args)
            entered()
            await gate
            return result
          })
      } else {
        jest
          .spyOn(authFetch as any, 'waitForPendingCertificateRequests')
          .mockImplementation(async () => {
            entered()
            await gate
          })
      }
      const payment = paid ? { txid: 'ab'.repeat(32), state: 'submitted' } : undefined
      const request = authFetch.fetch('https://service.example/resource', {
        signal: controller.signal,
        paymentContext: payment as any
      })
      const rejected = expect(request).rejects.toMatchObject({
        code: 'ERR_PAYMENT_CANCELLED',
        message: 'Paid request cancelled.',
        payment
      })
      await started
      controller.abort()
      release()
      await rejected
      expect(peer.toPeer).not.toHaveBeenCalled()
      expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledTimes(
        phase === 'serialization' ? 0 : 1
      )
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
      expect((authFetch as any).pendingRequestNonces.size).toBe(0)
    }
  )

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
    expect(fetchSpy.mock.calls[1][1]?.retryCounter).toBe(3)
    expect(config.retryCounter).toBeUndefined()
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
