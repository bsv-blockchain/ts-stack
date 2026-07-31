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
