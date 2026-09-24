import { jest } from '@jest/globals'
import { SimplifiedFetchTransport } from '../SimplifiedFetchTransport.js'
import * as Utils from '../../../primitives/utils.js'
import { AuthMessage } from '../../types.js'
import { AuthFetch } from '../../clients/AuthFetch.js'

function createGeneralPayload(
  path = '/resource',
  method = 'GET',
  headers: Array<[string, string]> = []
): number[] {
  const writer = new Utils.Writer()
  const requestId = Array.from({ length: 32 }).fill(1)
  writer.write(requestId)

  const methodBytes = Utils.toArray(method, 'utf8')
  writer.writeVarIntNum(methodBytes.length)
  writer.write(methodBytes)

  const pathBytes = Utils.toArray(path, 'utf8')
  writer.writeVarIntNum(pathBytes.length)
  writer.write(pathBytes)

  writer.writeVarIntNum(-1) // no query string
  writer.writeVarIntNum(headers.length)
  for (const [name, value] of headers) {
    for (const text of [name, value]) {
      const bytes = Utils.toArray(text, 'utf8')
      writer.writeVarIntNum(bytes.length)
      writer.write(bytes)
    }
  }
  writer.writeVarIntNum(-1) // no body

  return writer.toArray()
}

function createGeneralMessage(overrides: Partial<AuthMessage> = {}): AuthMessage {
  return {
    version: '1.0',
    messageType: 'general',
    identityKey: 'client-key',
    nonce: 'client-nonce',
    yourNonce: 'server-nonce',
    payload: createGeneralPayload(),
    signature: Array.from({ length: 64 }).fill(0),
    ...overrides
  }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('SimplifiedFetchTransport send', () => {
  test('wraps network failures with context', async () => {
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn()
    fetchMock.mockRejectedValue(new Error('network down'))
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any)
    await transport.onData(async () => {})
    const message = createGeneralMessage()

    let caught: any
    await expect(
      (async () => {
        try {
          await transport.send(message)
        } catch (error) {
          caught = error
          throw error
        }
      })()
    ).rejects.toThrow(
      'Network error while sending authenticated request to https://api.example.com/resource: network down'
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/resource')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
    expect(caught).toBeInstanceOf(Error)
    expect(caught.cause).toBeInstanceOf(Error)
    expect(caught.cause?.message).toBe('network down')
  })

  test('forbids automatic redirects for authentication handshakes', async () => {
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn()
    fetchMock.mockRejectedValue(new TypeError('fetch failed: redirect mode is set to error'))
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any)
    await transport.onData(async () => {})

    await expect(
      transport.send({
        version: '1.0',
        messageType: 'initialRequest',
        identityKey: 'client-key',
        nonce: 'client-nonce'
      } as AuthMessage)
    ).rejects.toThrow('Network error while sending authenticated request')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
  })

  test('throws when server omits authentication headers', async () => {
    const response = new Response('missing auth', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain'
      }
    })
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn()
    fetchMock.mockResolvedValue(response)
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any)
    await transport.onData(async () => {})

    const message = createGeneralMessage()

    let thrown: any
    await expect(
      (async () => {
        try {
          await transport.send(message)
        } catch (error) {
          thrown = error
          throw error
        }
      })()
    ).rejects.toThrow(
      'Received HTTP 200 from https://api.example.com/resource without valid BSV authentication (missing headers: x-bsv-auth-version, x-bsv-auth-identity-key, x-bsv-auth-signature)'
    )

    expect(thrown.details).toMatchObject({
      url: 'https://api.example.com/resource',
      status: 200,
      missingHeaders: ['x-bsv-auth-version', 'x-bsv-auth-identity-key', 'x-bsv-auth-signature']
    })
    expect(thrown.details.bodyPreview).toContain('missing auth')
  })

  test('rejects malformed requested certificates header', async () => {
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn()
    fetchMock.mockResolvedValue(
      new Response('', {
        status: 200,
        headers: {
          'x-bsv-auth-version': '0.1',
          'x-bsv-auth-identity-key': 'server-key',
          'x-bsv-auth-signature': 'deadbeef',
          'x-bsv-auth-message-type': 'general',
          'x-bsv-auth-request-id': Utils.toBase64(Array.from({ length: 32 }).fill(2)),
          'x-bsv-auth-requested-certificates': 'not-json'
        }
      })
    )

    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any)
    await transport.onData(async () => {})
    const message = createGeneralMessage()

    await expect(transport.send(message)).rejects.toThrow(
      'Failed to parse x-bsv-auth-requested-certificates returned by https://api.example.com/resource: not-json'
    )
  })

  test('rejects oversized signed and certificate-policy response headers', async () => {
    const responseHeaders = {
      'x-bsv-auth-version': '0.1',
      'x-bsv-auth-identity-key': 'server-key',
      'x-bsv-auth-signature': 'deadbeef',
      'x-bsv-custom': 'x'.repeat(32 * 1024 + 1)
    }
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 200, headers: responseHeaders }))
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any)
    await transport.onData(async () => {})
    await expect(transport.send(createGeneralMessage())).rejects.toThrow('oversized signed header')

    fetchMock.mockResolvedValueOnce(
      new Response('', {
        status: 200,
        headers: {
          'x-bsv-auth-version': '0.1',
          'x-bsv-auth-identity-key': 'server-key',
          'x-bsv-auth-signature': 'deadbeef',
          'x-bsv-auth-requested-certificates': 'x'.repeat(256 * 1024 + 1)
        }
      })
    )
    await expect(transport.send(createGeneralMessage())).rejects.toThrow(
      'header exceeds its byte limit'
    )
  })

  test('rejects non-canonical request IDs and signature encodings before callback delivery', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response('', {
        status: 200,
        headers: {
          'x-bsv-auth-version': '0.1',
          'x-bsv-auth-identity-key': 'server-key',
          'x-bsv-auth-signature': 'deadbeef',
          'x-bsv-auth-request-id': 'AQ=='
        }
      })
    )
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any)
    await transport.onData(async () => {})
    await expect(transport.send(createGeneralMessage())).rejects.toThrow('encode exactly 32 bytes')

    fetchMock.mockResolvedValueOnce(
      new Response('', {
        status: 200,
        headers: {
          'x-bsv-auth-version': '0.1',
          'x-bsv-auth-identity-key': 'server-key',
          'x-bsv-auth-signature': 'abc'
        }
      })
    )
    await expect(transport.send(createGeneralMessage())).rejects.toThrow(
      'signature must be bounded even-length hexadecimal'
    )
  })

  test('cancels an authenticated response that exceeds the configured streaming limit', async () => {
    const cancel = jest.fn()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3))
        controller.enqueue(Uint8Array.of(4, 5))
      },
      cancel
    })
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          'x-bsv-auth-version': '0.1',
          'x-bsv-auth-identity-key': 'server-key',
          'x-bsv-auth-signature': 'deadbeef'
        }
      })
    )
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any, {
      maxResponseBytes: 4
    })
    await transport.onData(async () => {})

    await expect(transport.send(createGeneralMessage())).rejects.toThrow('exceeds 4 bytes')
    expect(cancel).toHaveBeenCalled()
  })

  test.each(['4x', 'x4', '-1'])(
    'rejects a noncanonical Content-Length value %j before reading',
    async contentLength => {
      const transport = new SimplifiedFetchTransport('https://api.example.com', jest.fn() as any, {
        maxResponseBytes: 4
      })
      await expect(
        (transport as any).readResponseBody(
          'https://api.example.com/resource',
          new Response('data', { headers: { 'content-length': contentLength } }),
          4
        )
      ).rejects.toThrow('Invalid Content-Length returned by https://api.example.com/resource')
    }
  )

  test('rejects and cancels a declared body above the configured limit', async () => {
    const cancel = jest.fn(() => {
      throw new Error('synthetic cancellation failure')
    })
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': '5' }
    })
    const transport = new SimplifiedFetchTransport('https://api.example.com', jest.fn() as any)
    await expect(
      (transport as any).readResponseBody('https://api.example.com/resource', response, 4)
    ).rejects.toThrow(
      'Authenticated response from https://api.example.com/resource exceeds 4 bytes'
    )
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test('rejects an oversized declared body when no response stream is present', async () => {
    const transport = new SimplifiedFetchTransport('https://api.example.com', jest.fn() as any)
    const response = new Response(null, { headers: { 'content-length': '5' } })

    await expect(
      (transport as any).readResponseBody('https://api.example.com/resource', response, 4)
    ).rejects.toThrow(
      'Authenticated response from https://api.example.com/resource exceeds 4 bytes'
    )
  })

  test('accepts the exact declared and streamed limit and joins chunks in order', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3, 4, 5, 6))
        controller.enqueue(Uint8Array.of(7, 8, 9, 10, 11, 12))
        controller.close()
      }
    })
    const response = new Response(body, { headers: { 'content-length': '12' } })
    const transport = new SimplifiedFetchTransport('https://api.example.com', jest.fn() as any)
    await expect(
      (transport as any).readResponseBody('https://api.example.com/resource', response, 12)
    ).resolves.toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  test('rejects an already-aborted response read and releases its stream lock', async () => {
    const reader = {
      cancel: jest.fn(async () => {}),
      read: jest.fn(async () => ({ done: true, value: undefined })),
      releaseLock: jest.fn()
    }
    const body = { getReader: jest.fn(() => reader) }
    const addEventListener = jest.fn()
    const removeEventListener = jest.fn()
    const signal = {
      aborted: true,
      addEventListener,
      removeEventListener
    } as unknown as AbortSignal
    const response = {
      headers: new Headers(),
      body
    } as unknown as Response
    const transport = new SimplifiedFetchTransport('https://api.example.com', jest.fn() as any)

    await expect(
      (transport as any).readResponseBody('https://api.example.com/resource', response, 4, signal)
    ).rejects.toThrow('Authenticated request to https://api.example.com/resource timed out')

    expect(reader.read).not.toHaveBeenCalled()
    expect(addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
  })

  test('returns an empty body without allocating a stream reader', async () => {
    const transport = new SimplifiedFetchTransport('https://api.example.com', jest.fn() as any)
    await expect(
      (transport as any).readResponseBody('https://api.example.com/resource', new Response(null), 4)
    ).resolves.toEqual([])
  })

  test('bounds authentication handshake responses before parsing JSON', async () => {
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn().mockResolvedValue(
      new Response('{"too":"large"}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any, {
      maxHandshakeResponseBytes: 4
    })
    await transport.onData(async () => {})

    await expect(
      transport.send({
        version: '1.0',
        messageType: 'initialRequest',
        identityKey: 'client-key',
        nonce: 'client-nonce'
      } as AuthMessage)
    ).rejects.toThrow('exceeds 4 bytes')
  })

  test('aborts a fetch that never returns response headers', async () => {
    const fetchMock = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any, {
      requestTimeoutMs: 10
    })
    await transport.onData(async () => {})

    await expect(transport.send(createGeneralMessage())).rejects.toThrow('timed out after 10')
    const firstCall = fetchMock.mock.calls[0]
    if (firstCall == null) throw new Error('fetch was not called')
    const signal = (firstCall[1] as RequestInit).signal as AbortSignal
    expect(signal.aborted).toBe(true)
  })

  test('cancels a response stream that never yields or closes', async () => {
    const cancel = jest.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: async () => await new Promise(() => {}),
        cancel
      }),
      {
        status: 200,
        headers: {
          'x-bsv-auth-version': '0.1',
          'x-bsv-auth-identity-key': 'server-key',
          'x-bsv-auth-signature': 'deadbeef'
        }
      }
    )
    const transport = new SimplifiedFetchTransport(
      'https://api.example.com',
      jest.fn().mockResolvedValue(response) as any,
      { requestTimeoutMs: 10 }
    )
    await transport.onData(async () => {})

    await expect(transport.send(createGeneralMessage())).rejects.toThrow('timed out after 10')
    expect(cancel).toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Authenticated response deadline exceeded' })
    )
  })
})

describe('BRC-105 payment request header bounds', () => {
  const aggregateLimit = 256 * 1024
  const paymentName = 'x-bsv-payment'
  const transport = new SimplifiedFetchTransport('https://api.example.com')

  test('sends a payment proof header above the historical limit without changing its bytes', async () => {
    const payment = JSON.stringify({
      derivationPrefix: 'a'.repeat(44),
      derivationSuffix: 'b'.repeat(44),
      transaction: Utils.toBase64(Array.from({ length: 8094 }, () => 1))
    })
    expect(Utils.toArray(payment, 'utf8')).toHaveLength(10942)
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn()
    fetchMock.mockRejectedValue(new Error('network sentinel'))
    const sendingTransport = new SimplifiedFetchTransport('https://api.example.com', fetchMock)
    await sendingTransport.onData(async () => {})
    await expect(
      sendingTransport.send(
        createGeneralMessage({
          payload: createGeneralPayload('/paid', 'GET', [[paymentName, payment]])
        })
      )
    ).rejects.toThrow('network sentinel')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ [paymentName]: payment })
  })

  test.each(['x-bsv-payment', 'X-BSV-Payment'])('preserves the aggregate boundary for %s', name => {
    const value = 'a'.repeat(aggregateLimit - name.length)
    expect(
      transport.deserializeRequestPayload(createGeneralPayload('/paid', 'GET', [[name, value]]))
        .headers[name]
    ).toBe(value)
    expect(() =>
      transport.deserializeRequestPayload(
        createGeneralPayload('/paid', 'GET', [[name, value + 'a']])
      )
    ).toThrow('headers exceed their byte limit')
  })

  test('counts other headers against the same increased aggregate ceiling', () => {
    const headers: Array<[string, string]> = [
      [paymentName, 'a'.repeat(aggregateLimit - paymentName.length - 2)],
      ['x', 'a']
    ]
    expect(
      transport.deserializeRequestPayload(createGeneralPayload('/paid', 'GET', headers)).headers.x
    ).toBe('a')
    headers[1][1] += 'a'
    expect(() =>
      transport.deserializeRequestPayload(createGeneralPayload('/paid', 'GET', headers))
    ).toThrow('headers exceed their byte limit')
  })

  test.each(['authorization', 'x-bsv-other', 'x-bsv-payment-extra'])(
    'enforces the increased ordinary 32 KiB ceiling for %s',
    name => {
      expect(
        transport.deserializeRequestPayload(
          createGeneralPayload('/paid', 'GET', [[name, 'a'.repeat(32 * 1024)]])
        ).headers[name]
      ).toHaveLength(32 * 1024)
      expect(() =>
        transport.deserializeRequestPayload(
          createGeneralPayload('/paid', 'GET', [[name, 'a'.repeat(32 * 1024 + 1)]])
        )
      ).toThrow('header value exceeds its byte limit')
    }
  )

  test('rejects an over-limit payment value before reading it', () => {
    expect(() =>
      transport.deserializeRequestPayload(
        createGeneralPayload('/paid', 'GET', [[paymentName, 'a'.repeat(aggregateLimit + 1)]])
      )
    ).toThrow('header value exceeds its byte limit')
  })
})

describe('HTTP header capacity in both directions', () => {
  const aggregateLimit = 256 * 1024
  const valueLimit = 32 * 1024
  const nameLimit = 1024
  const countLimit = 512

  async function receive(headers: Array<[string, string]>): Promise<AuthMessage> {
    const response = new Response(null, {
      headers: [
        ['x-bsv-auth-version', '0.1'],
        ['x-bsv-auth-identity-key', 'server-key'],
        ['x-bsv-auth-signature', 'deadbeef'],
        ['x-bsv-auth-request-id', Utils.toBase64(Array.from({ length: 32 }).fill(2))],
        ...headers
      ]
    })
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(response)
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock)
    let received: AuthMessage | undefined
    await transport.onData(async message => {
      received = message
    })
    await transport.send(createGeneralMessage())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(received).toBeDefined()
    return received!
  }

  async function roundTrip(
    direction: string,
    headers: Array<[string, string]>
  ): Promise<Array<[string, string]>> {
    if (direction === 'request') {
      const transport = new SimplifiedFetchTransport('https://api.example.com')
      return Object.entries(
        transport.deserializeRequestPayload(createGeneralPayload('/', 'GET', headers)).headers
      )
    }
    const message = await receive(headers)
    // Exercise the second SDK parser too, even with a small body budget.
    const client = new AuthFetch({} as never, undefined, undefined, undefined, {
      maxResponseBytes: 1
    })
    const parsed = (client as any).parseAuthenticatedResponse(
      'https://api.example.com',
      Utils.toBase64(Array.from({ length: 32 }).fill(2)),
      'server-key',
      message.payload
    ) as Response
    for (const [name, value] of headers) expect(parsed.headers.get(name)).toBe(value)
    const reader = new Utils.Reader(message.payload!)
    expect(reader.read(32)).toEqual(Array.from({ length: 32 }).fill(2))
    expect(reader.readVarIntNum()).toBe(200)
    const count = reader.readVarIntNum()
    const result: Array<[string, string]> = []
    for (let i = 0; i < count; i++) {
      const name = Utils.toUTF8(reader.read(reader.readVarIntNum()))
      const value = Utils.toUTF8(reader.read(reader.readVarIntNum()))
      result.push([name, value])
    }
    expect(reader.readVarIntNum()).toBe(-1)
    expect(reader.eof()).toBe(true)
    return result
  }

  describe.each(['request', 'response'])('%s', direction => {
    test('preserves a 32 KiB value and rejects the next byte', async () => {
      const headers: Array<[string, string]> = [['x-bsv-large', 'a'.repeat(valueLimit)]]
      await expect(roundTrip(direction, headers)).resolves.toEqual(headers)
      headers[0][1] += 'a'
      await expect(roundTrip(direction, headers)).rejects.toThrow(/header/)
    })

    test('counts value bytes, including multibyte UTF-8', async () => {
      const headers: Array<[string, string]> = [['x-bsv-large', 'é'.repeat(valueLimit / 2)]]
      await expect(roundTrip(direction, headers)).resolves.toEqual(headers)
      headers[0][1] += 'é'
      await expect(roundTrip(direction, headers)).rejects.toThrow(/header/)
    })

    test('accepts a 1 KiB name and rejects the next byte', async () => {
      const headers: Array<[string, string]> = [['x-bsv-' + 'a'.repeat(nameLimit - 6), 'v']]
      await expect(roundTrip(direction, headers)).resolves.toEqual(headers)
      headers[0][0] += 'a'
      await expect(roundTrip(direction, headers)).rejects.toThrow(/header/)
    })

    test('accepts 512 distinct headers and rejects the next one', async () => {
      const headers: Array<[string, string]> = Array.from({ length: countLimit }, (_, i) => [
        `x-bsv-${String(i).padStart(3, '0')}`,
        'v'
      ])
      await expect(roundTrip(direction, headers)).resolves.toEqual(headers)
      headers.push(['x-bsv-extra', 'v'])
      await expect(roundTrip(direction, headers)).rejects.toThrow(/header/)
    })

    test('accepts 256 KiB aggregate names and values and rejects the next byte', async () => {
      const headers: Array<[string, string]> = Array.from({ length: 8 }, (_, i) => [
        `x-bsv-${i}`,
        'a'.repeat(valueLimit - 7)
      ])
      expect(headers.reduce((size, [name, value]) => size + name.length + value.length, 0)).toBe(
        aggregateLimit
      )
      await expect(roundTrip(direction, headers)).resolves.toEqual(headers)
      headers[0][1] += 'a'
      await expect(roundTrip(direction, headers)).rejects.toThrow(/headers.*limit/)
    })
  })

  test('parses a 256 KiB certificate policy and rejects the next byte', async () => {
    const empty = JSON.stringify({ certifiers: [''], types: {} })
    const policy = { certifiers: ['a'.repeat(aggregateLimit - empty.length)], types: {} }
    const value = JSON.stringify(policy)
    expect(Utils.toArray(value, 'utf8')).toHaveLength(aggregateLimit)
    await expect(receive([['x-bsv-auth-requested-certificates', value]])).resolves.toMatchObject({
      requestedCertificates: policy
    })
    policy.certifiers[0] += 'a'
    await expect(
      receive([['x-bsv-auth-requested-certificates', JSON.stringify(policy)]])
    ).rejects.toThrow('header exceeds its byte limit')
  })
})
