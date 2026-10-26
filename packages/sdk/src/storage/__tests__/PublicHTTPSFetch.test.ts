import {
  createPublicHTTPSFetch,
  createPublicNetworkFetch,
  isPublicNetworkAddress
} from '../PublicHTTPSFetch.js'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

type LookupResult = {
  error: Error | null
  address?: string | Array<{ address: string; family: number }>
  family?: number
}

type CapturedRequest = {
  url: URL
  options: {
    method?: string
    headers?: Record<string, string>
    lookup: (
      hostname: string,
      options: number | { family?: number; all?: boolean },
      callback: (
        error: Error | null,
        address?: string | Array<{ address: string; family: number }>,
        family?: number
      ) => void
    ) => void
  }
  respond: (response: Readable & { statusCode?: number; statusMessage?: string }) => void
}

class FakeClientRequest extends EventEmitter {
  endedBody: string | Uint8Array | undefined
  readonly destroyedWith: Array<Error | undefined> = []
  timeoutMilliseconds: number | undefined
  timeoutCallback: (() => void) | undefined

  destroy(error?: Error): void {
    this.destroyedWith.push(error)
    if (error !== undefined) this.emit('error', error)
  }

  end(body?: string | Uint8Array): void {
    this.endedBody = body
  }

  setTimeout(milliseconds: number, callback: () => void): this {
    this.timeoutMilliseconds = milliseconds
    this.timeoutCallback = callback
    return this
  }
}

function makeIncomingResponse(
  statusCode: number | undefined,
  body: string | null = null,
  rawHeaders: string[] = []
): Readable & {
  statusCode?: number
  statusMessage?: string
  rawHeaders: string[]
} {
  const response = Readable.from(body === null ? [] : [Buffer.from(body)]) as Readable & {
    statusCode?: number
    statusMessage?: string
    rawHeaders: string[]
  }
  response.statusCode = statusCode
  response.statusMessage = statusCode === 201 ? 'Created' : 'OK'
  response.rawHeaders = rawHeaders
  return response
}

function installNodeTransport(): {
  request: FakeClientRequest
  requestMock: jest.Mock
  requestedModules: string[]
  captured: () => CapturedRequest
} {
  const request = new FakeClientRequest()
  const requestedModules: string[] = []
  let capturedRequest: CapturedRequest | undefined
  const requestMock = jest.fn(
    (
      url: URL,
      options: CapturedRequest['options'],
      respond: CapturedRequest['respond']
    ): FakeClientRequest => {
      capturedRequest = { url, options, respond }
      return request
    }
  )
  jest.spyOn(process, 'getBuiltinModule').mockImplementation(name => {
    requestedModules.push(name)
    if (name === 'node:https' || name === 'node:http') return { request: requestMock } as never
    if (name === 'node:stream') return { Readable } as never
    throw new Error(`Unexpected built-in module: ${name}`)
  })
  return {
    request,
    requestMock,
    requestedModules,
    captured: () => {
      if (capturedRequest === undefined) throw new Error('Transport request was not created')
      return capturedRequest
    }
  }
}

async function waitForCapturedRequest(
  transport: ReturnType<typeof installNodeTransport>
): Promise<CapturedRequest> {
  for (let attempt = 0; attempt < 10 && transport.requestMock.mock.calls.length === 0; attempt++) {
    await Promise.resolve()
  }
  expect(transport.requestMock).toHaveBeenCalledTimes(1)
  return transport.captured()
}

function callLookup(
  lookup: CapturedRequest['options']['lookup'],
  options: number | { family?: number; all?: boolean }
): LookupResult {
  let result: LookupResult | undefined
  lookup('ignored.example', options, (error, address, family) => {
    result = { error, address, family }
  })
  if (result === undefined) throw new Error('Pinned lookup did not invoke its callback')
  return result
}

const publicAddressResolver = async (): Promise<Array<{ address: string; family: number }>> => [
  { address: '93.184.216.34', family: 4 }
]

describe('certificate issuer SSRF boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '100::1',
    '2001:db8::1',
    '3fff::1'
  ])('classifies non-public address %s as unsafe', address => {
    expect(isPublicNetworkAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '2606:4700:4700::1111'])('accepts public address %s', address => {
    expect(isPublicNetworkAddress(address)).toBe(true)
  })

  it.each([
    '999.1.1.1',
    '1.two.3.4',
    'fe80::1%lo0',
    '1::2::3',
    '1.2.3.4:1::',
    'gggg::1',
    '1:2:3:4:5:6:7:8::',
    '2001:4860:4860:0:0:0:8888',
    '::8.8.8.8',
    '64:ff9b::808:808'
  ])('rejects malformed address %s', address => {
    expect(isPublicNetworkAddress(address)).toBe(false)
  })

  it.each(['::ffff:8.8.8.8', '2002:0808:0808::', '2606:4700:4700:0:0:0:0:1111'])(
    'accepts public IPv4 embeddings and full IPv6 form %s',
    address => {
      expect(isPublicNetworkAddress(address)).toBe(true)
    }
  )

  it('rejects a private DNS answer before opening the TLS request', async () => {
    const resolver = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }])
    const safeFetch = createPublicHTTPSFetch('https://issuer.example', resolver)

    await expect(safeFetch('https://issuer.example/signCertificate')).rejects.toThrow(
      'non-public address'
    )
    expect(resolver).toHaveBeenCalledWith('issuer.example')
  })

  it('rejects mixed public/private DNS answers and origin escapes', async () => {
    const resolver = jest.fn(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 }
    ])
    const safeFetch = createPublicHTTPSFetch('https://issuer.example', resolver)

    await expect(safeFetch('https://issuer.example/signCertificate')).rejects.toThrow(
      'non-public address'
    )
    await expect(safeFetch('https://attacker.example/signCertificate')).rejects.toThrow(
      'escaped its validated origin'
    )
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('rejects direct private targets and authority-altering headers', async () => {
    const resolver = jest.fn(async () => [{ address: '8.8.8.8', family: 4 }])
    const safeFetch = createPublicHTTPSFetch(undefined, resolver)

    await expect(safeFetch('https://127.0.0.1/private')).rejects.toThrow('non-public address')
    await expect(
      safeFetch('https://issuer.example/signCertificate', { headers: { Host: 'internal' } })
    ).rejects.toThrow('forbids the host header')
  })

  it('pins explicitly enabled HTTP requests and rejects private DNS answers', async () => {
    const resolver = jest.fn(async () => [{ address: '10.0.0.1', family: 4 }])
    const safeFetch = createPublicNetworkFetch({ allowHTTP: true }, resolver)

    await expect(safeFetch('http://storage.example/upload')).rejects.toThrow('non-public address')
  })

  it('accepts only a canonical Content-Length matching the request body', async () => {
    const resolver = jest.fn(async () => [{ address: '8.8.8.8', family: 4 }])
    const safeFetch = createPublicHTTPSFetch(undefined, resolver)

    await expect(
      safeFetch('https://storage.example/upload', {
        method: 'PUT',
        body: Uint8Array.of(1, 2, 3),
        headers: { 'Content-Length': '2' }
      })
    ).rejects.toThrow('does not match its body')
  })

  it('applies the SSRF policy to every default DNS result before opening a socket', async () => {
    const lookup = jest.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 }
    ])
    const request = jest.fn()
    jest.spyOn(process, 'getBuiltinModule').mockImplementation(name => {
      if (name === 'node:dns/promises') return { lookup } as never
      if (name === 'node:https') return { request } as never
      throw new Error(`Unexpected built-in module: ${name}`)
    })

    await expect(createPublicHTTPSFetch()('https://issuer.example/certificate')).rejects.toThrow(
      'non-public address'
    )
    expect(lookup).toHaveBeenCalledWith('issuer.example', { all: true, verbatim: true })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    [[], 'non-public address'],
    [Array.from({ length: 65 }, () => ({ address: '93.184.216.34', family: 4 })), 'non-public'],
    [[{ address: '93.184.216.34', family: 5 }], 'non-public']
  ])('rejects empty, oversized, and invalid-family DNS answers', async (addresses, message) => {
    const resolver = jest.fn(async () => addresses)
    const getBuiltinModule = jest.spyOn(process, 'getBuiltinModule')

    await expect(
      createPublicHTTPSFetch(undefined, resolver)('https://issuer.example/certificate')
    ).rejects.toThrow(message)
    expect(getBuiltinModule).not.toHaveBeenCalled()
  })

  it('bounds DNS resolution time', async () => {
    jest.useFakeTimers()
    const neverResolves = async (): Promise<Array<{ address: string; family: number }>> =>
      await new Promise(() => {})
    const request = createPublicHTTPSFetch(
      undefined,
      neverResolves
    )('https://issuer.example/certificate')
    const rejection = expect(request).rejects.toThrow('DNS resolution timed out')

    await jest.advanceTimersByTimeAsync(30_000)
    await rejection
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each([
    'http://issuer.example/certificate',
    'https://user:secret@issuer.example/certificate',
    'https://issuer.example/certificate#fragment'
  ])('rejects unsafe URL form before resolving DNS: %s', async url => {
    const resolver = jest.fn(publicAddressResolver)

    await expect(createPublicHTTPSFetch(undefined, resolver)(url)).rejects.toThrow(
      'credential-free HTTPS URL'
    )
    expect(resolver).not.toHaveBeenCalled()
  })

  it('rejects Request objects before resolving DNS', async () => {
    const resolver = jest.fn(publicAddressResolver)
    const request = new Request('https://issuer.example/certificate')

    await expect(createPublicHTTPSFetch(undefined, resolver)(request)).rejects.toThrow(
      'does not accept Request objects'
    )
    expect(resolver).not.toHaveBeenCalled()
  })

  it.each(['ftp://issuer.example', 'https://user:secret@issuer.example'])(
    'rejects unsafe expected origin at construction: %s',
    origin => {
      expect(() => createPublicHTTPSFetch(origin)).toThrow(
        'origin must use an allowed HTTP protocol'
      )
    }
  )

  it('uses the browser fallback only with redirect rejection when Node modules are unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule')
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('browser response', { status: 200 }))
    Object.defineProperty(process, 'getBuiltinModule', {
      configurable: true,
      value: undefined,
      writable: true
    })

    try {
      const response = await createPublicHTTPSFetch()('https://issuer.example/certificate', {
        headers: { Accept: 'application/json' }
      })
      await expect(response.text()).resolves.toBe('browser response')
      expect(fetchSpy).toHaveBeenCalledWith(new URL('https://issuer.example/certificate'), {
        headers: { Accept: 'application/json' },
        redirect: 'error'
      })
    } finally {
      if (descriptor !== undefined) Object.defineProperty(process, 'getBuiltinModule', descriptor)
    }
  })

  it('pins every approved DNS answer and preserves request and response metadata', async () => {
    const transport = installNodeTransport()
    const resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 }
    ]
    const request = createPublicHTTPSFetch('https://issuer.example', resolver)(
      new URL('https://issuer.example/certificate'),
      { method: 'POST', headers: { 'X-Request': 'value' }, body: 'é' }
    )
    const captured = await waitForCapturedRequest(transport)

    expect(captured.url.toString()).toBe('https://issuer.example/certificate')
    expect(captured.options.method).toBe('POST')
    expect(captured.options.headers).toEqual({
      'content-length': '2',
      'x-request': 'value'
    })
    expect(transport.request.endedBody).toBe('é')
    expect(transport.request.timeoutMilliseconds).toBe(30_000)
    expect(callLookup(captured.options.lookup, { all: true })).toEqual({
      error: null,
      address: [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 }
      ],
      family: undefined
    })
    expect(callLookup(captured.options.lookup, 4)).toEqual({
      error: null,
      address: '93.184.216.34',
      family: 4
    })
    expect(callLookup(captured.options.lookup, { family: 6 })).toEqual({
      error: null,
      address: '2606:4700:4700::1111',
      family: 6
    })
    expect(callLookup(captured.options.lookup, { family: 5 }).error).toEqual(
      new Error('Restricted HTTPS request has no approved address for this family')
    )

    captured.respond(
      makeIncomingResponse(201, 'certificate', [
        'Content-Type',
        'application/octet-stream',
        'X-Issuer',
        'example',
        'Ignored-Odd-Tail'
      ])
    )
    const response = await request
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('x-issuer')).toBe('example')
    expect(response.headers.has('ignored-odd-tail')).toBe(false)
    await expect(response.text()).resolves.toBe('certificate')
  })

  it.each([
    [new Uint8Array([1, 2, 3]).buffer, new Uint8Array([1, 2, 3])],
    [new DataView(new Uint8Array([4, 5, 6, 7]).buffer, 1, 2), new Uint8Array([5, 6])]
  ])('normalizes supported binary request bodies', async (body, expected) => {
    const transport = installNodeTransport()
    const request = createPublicHTTPSFetch(undefined, publicAddressResolver)(
      'https://storage.example/upload',
      { method: 'PUT', body }
    )
    const captured = await waitForCapturedRequest(transport)

    expect(transport.request.endedBody).toEqual(expected)
    expect(captured.options.headers?.['content-length']).toBe(String(expected.byteLength))
    captured.respond(makeIncomingResponse(204))
    await expect(request).resolves.toMatchObject({ status: 204, body: null })
  })

  it('rejects unsupported request bodies before opening a socket', async () => {
    const transport = installNodeTransport()
    const body = new Blob(['body'])

    await expect(
      createPublicHTTPSFetch(undefined, publicAddressResolver)('https://storage.example/upload', {
        method: 'PUT',
        body
      })
    ).rejects.toThrow('body type is unsupported')
    expect(transport.requestMock).not.toHaveBeenCalled()
  })

  it.each([
    [{ 'Content-Length': '0' }, undefined],
    [{ 'Content-Length': '03' }, new Uint8Array([1, 2, 3])],
    [{ 'Content-Length': '-1' }, new Uint8Array([1])]
  ])('rejects ambiguous or bodyless Content-Length declarations', async (headers, body) => {
    const transport = installNodeTransport()

    await expect(
      createPublicHTTPSFetch(undefined, publicAddressResolver)('https://storage.example/upload', {
        method: 'PUT',
        headers,
        body
      })
    ).rejects.toThrow('Content-Length does not match its body')
    expect(transport.requestMock).not.toHaveBeenCalled()
  })

  it('uses the explicitly enabled HTTP module without weakening address checks', async () => {
    const transport = installNodeTransport()
    const request = createPublicNetworkFetch(
      { expectedOrigin: 'http://storage.example', allowHTTP: true },
      publicAddressResolver
    )('http://storage.example/upload')
    const captured = await waitForCapturedRequest(transport)

    expect(transport.requestedModules).toContain('node:http')
    captured.respond(makeIncomingResponse(204))
    await expect(request).resolves.toMatchObject({ status: 204 })
  })

  it.each([undefined, 600])(
    'rejects invalid HTTP status %s and drains the response',
    async status => {
      const transport = installNodeTransport()
      const request = createPublicHTTPSFetch(
        undefined,
        publicAddressResolver
      )('https://issuer.example/certificate')
      const captured = await waitForCapturedRequest(transport)
      const response = makeIncomingResponse(status)
      const resume = jest.spyOn(response, 'resume')

      captured.respond(response)
      await expect(request).rejects.toThrow('invalid HTTP status')
      expect(resume).toHaveBeenCalledTimes(1)
    }
  )

  it.each([204, 205, 304])('drains bodyless HTTP status %s', async status => {
    const transport = installNodeTransport()
    const request = createPublicHTTPSFetch(
      undefined,
      publicAddressResolver
    )('https://issuer.example/certificate')
    const captured = await waitForCapturedRequest(transport)
    const incoming = makeIncomingResponse(status)
    const resume = jest.spyOn(incoming, 'resume')

    captured.respond(incoming)
    await expect(request).resolves.toMatchObject({ status, body: null })
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('propagates transport errors and request timeouts', async () => {
    const transportError = installNodeTransport()
    const failedRequest = createPublicHTTPSFetch(
      undefined,
      publicAddressResolver
    )('https://issuer.example/certificate')
    await waitForCapturedRequest(transportError)
    transportError.request.emit('error', new Error('socket failed'))
    await expect(failedRequest).rejects.toThrow('socket failed')
    jest.restoreAllMocks()

    const timedOut = installNodeTransport()
    const timedOutRequest = createPublicHTTPSFetch(
      undefined,
      publicAddressResolver
    )('https://issuer.example/certificate')
    await waitForCapturedRequest(timedOut)
    timedOut.request.timeoutCallback?.()
    await expect(timedOutRequest).rejects.toThrow('request timed out')
    expect(timedOut.request.destroyedWith[0]).toEqual(
      new Error('Restricted HTTPS request timed out')
    )
  })

  it.each([false, true])('destroys %s-aborted requests with AbortError', async preAborted => {
    const transport = installNodeTransport()
    const controller = new AbortController()
    if (preAborted) controller.abort()
    const request = createPublicHTTPSFetch(undefined, publicAddressResolver)(
      'https://issuer.example/certificate',
      { signal: controller.signal }
    )
    await waitForCapturedRequest(transport)
    if (!preAborted) controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.request.destroyedWith).toHaveLength(1)
    controller.abort()
    expect(transport.request.destroyedWith).toHaveLength(1)
  })
})
