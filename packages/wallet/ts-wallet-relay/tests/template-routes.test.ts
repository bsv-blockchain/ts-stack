import { POST } from '../template/nextjs/app/api/request/[id]/route.js'
import { DELETE, GET as getSession } from '../template/nextjs/app/api/session/[id]/route.js'
import { GET as createSession } from '../template/nextjs/app/api/session/route.js'
import { templateRelay } from './fixtures/template-relay.js'

function request(
  headers: Record<string, string> = {},
  text = JSON.stringify({ method: 'getVersion', params: {} })
): Request {
  return {
    headers: new Headers(headers),
    text: async () => text
  } as Request
}

describe('Next.js scaffold route behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    [{}, 415],
    [{ 'content-type': 'text/plain' }, 415],
    [{ 'content-type': 'application/json', 'content-length': 'nope' }, 413],
    [{ 'content-type': 'application/json', 'content-length': '65537' }, 413]
  ])('rejects invalid request metadata %#', async (headers, status) => {
    await expect(
      POST(request(headers) as never, { params: { id: 'session' } })
    ).resolves.toMatchObject({ status })
    expect(templateRelay.sendRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['not-json', 400],
    ['[]', 400],
    ['{}', 400],
    [JSON.stringify({ method: '' }), 400],
    [JSON.stringify({ method: 'x'.repeat(101) }), 400]
  ])('rejects malformed JSON request bodies %#', async (body, status) => {
    const result = await POST(
      request({ 'content-type': 'application/json', 'x-desktop-token': 'token' }, body) as never,
      { params: { id: 'session' } }
    )
    expect(result.status).toBe(status)
    expect(templateRelay.sendRequest).not.toHaveBeenCalled()
  })

  it('bounds the actual encoded body and requires a desktop token', async () => {
    const oversized = JSON.stringify({ method: 'ok', params: 'x'.repeat(65_536) })
    await expect(
      POST(request({ 'content-type': 'application/json' }, oversized) as never, {
        params: { id: 'session' }
      })
    ).resolves.toMatchObject({ status: 413 })
    await expect(
      POST(
        request({ 'content-type': 'application/json' }, JSON.stringify({ method: 'ok' })) as never,
        { params: { id: 'session' } }
      )
    ).resolves.toMatchObject({ status: 401 })
  })

  it('forwards the exact session, method, params, and desktop token', async () => {
    templateRelay.sendRequest.mockResolvedValue({ ok: true })
    const result = await POST(
      request(
        { 'content-type': 'application/json; charset=utf-8', 'x-desktop-token': 'secret' },
        JSON.stringify({ method: 'getVersion', params: { one: 1 } })
      ) as never,
      { params: { id: 'session-1' } }
    )
    expect(result).toMatchObject({ status: 200, body: { ok: true } })
    expect(templateRelay.sendRequest).toHaveBeenCalledWith(
      'session-1',
      'getVersion',
      { one: 1 },
      'secret'
    )
    expect(result.headers.get('cache-control')).toBe('no-store, max-age=0')
  })

  it.each([
    [Object.assign(new Error('Invalid desktop token'), { code: 500 }), 401],
    [new Error('Session is not connected'), 400],
    [Object.assign(new Error('busy'), { code: 400 }), 400],
    [Object.assign(new Error('busy'), { code: 429 }), 429],
    ['opaque failure', 504]
  ])(
    'maps relay request failures without leaking cacheable responses %#',
    async (error, status) => {
      templateRelay.sendRequest.mockRejectedValue(error)
      const result = await POST(
        request({ 'content-type': 'application/json', 'x-desktop-token': 'secret' }) as never,
        { params: { id: 'session' } }
      )
      expect(result.status).toBe(status)
      expect(result.headers.get('cache-control')).toBe('no-store, max-age=0')
    }
  )

  it('gets an existing session and returns a bounded miss', () => {
    templateRelay.getSession.mockReturnValueOnce(undefined).mockReturnValueOnce({ id: 'session' })
    expect(getSession(request(), { params: { id: 'missing' } })).toMatchObject({ status: 404 })
    expect(getSession(request(), { params: { id: 'session' } })).toMatchObject({
      status: 200,
      body: { id: 'session' }
    })
  })

  it('authenticates session deletion and maps authoritative failures', () => {
    expect(DELETE(request(), { params: { id: 'session' } })).toMatchObject({ status: 401 })

    templateRelay.deleteSession.mockImplementationOnce(() => undefined)
    expect(
      DELETE(request({ 'x-desktop-token': 'secret' }), { params: { id: 'session' } })
    ).toMatchObject({ status: 204 })
    expect(templateRelay.deleteSession).toHaveBeenCalledWith('session', 'secret')

    for (const [error, status] of [
      [new Error('Invalid desktop token'), 401],
      [new Error('Session not found'), 404],
      ['opaque', 500]
    ] as const) {
      templateRelay.deleteSession.mockImplementationOnce(() => {
        throw error
      })
      expect(
        DELETE(request({ 'x-desktop-token': 'secret' }), { params: { id: 'session' } })
      ).toMatchObject({ status })
    }
  })

  it('binds session creation to origin and maps rate, allowlist, and opaque failures', async () => {
    templateRelay.createSession
      .mockResolvedValueOnce({ id: 'one' })
      .mockResolvedValueOnce({ id: 'two' })
    await expect(createSession(request() as never)).resolves.toMatchObject({ body: { id: 'one' } })
    await expect(
      createSession(request({ origin: 'https://wallet.example' }) as never)
    ).resolves.toMatchObject({ body: { id: 'two' } })
    expect(templateRelay.createSession).toHaveBeenNthCalledWith(1, undefined)
    expect(templateRelay.createSession).toHaveBeenNthCalledWith(2, {
      origin: 'https://wallet.example'
    })

    for (const [error, status] of [
      [Object.assign(new Error('busy'), { code: 429 }), 429],
      [new Error('origin is outside allowedOrigins'), 403],
      ['opaque', 500]
    ] as const) {
      templateRelay.createSession.mockRejectedValueOnce(error)
      await expect(createSession(request() as never)).resolves.toMatchObject({ status })
    }
  })
})
