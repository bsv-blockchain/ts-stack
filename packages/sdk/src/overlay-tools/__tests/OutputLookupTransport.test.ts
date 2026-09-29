import { jest } from '@jest/globals'
import {
  OutputLookupTransport,
  OutputLookupServiceError,
  OUTPUT_LOOKUP_PROFILE,
  AuthFetch,
  SimplifiedFetchTransport,
  CompletedProtoWallet,
  PrivateKey,
  outputPacketDigest,
  outputLookupCheckpoint,
  parseOutputLookupCheckpoint,
  retainOutputCapability,
  signOutputPacket,
  type OutputCapabilityRequest,
  type OutputLookupBatch,
  type OutputLookupLimits,
  type OutputLookupTransportOptions
} from '../../../mod.js'

const limits: OutputLookupLimits = { maxBytes: 65536, maxObservations: 10, waitMs: 0 }
const chain = { network: 'lookup-test', genesisHash: '01'.repeat(32) }
const key = new PrivateKey(71)
const identity = key.toPublicKey().toString()
const rules = { id: 'urn:test:lookup:1', parameters: { order: 'outpoint' } }
const rulesDigest = outputPacketDigest('service-rules', rules)
const opening = {
  version: 1,
  requestId: 'testing-open-00000000000001',
  service: 'ls_test',
  query: { text: 'hello' },
  requiredRulesDigest: rulesDigest,
  limits
}

afterEach(() => jest.restoreAllMocks())

function setup(overrides: Partial<OutputLookupTransportOptions> = {}, authentication = 'none') {
  const baseURL = 'https://example.test/tenant/api'
  const request: OutputCapabilityRequest = {
    baseURL,
    identity,
    chain,
    service: 'ls_test',
    kind: 'lookup',
    profile: OUTPUT_LOOKUP_PROFILE,
    now: '1000',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '2',
    rules: new Map([[rules.id, () => {}]])
  }
  const signed = signOutputPacket(
    'capabilities',
    {
      version: 1,
      baseURL,
      identity,
      chain,
      issuedAt: '999',
      expiresAt: '1100',
      services: [
        {
          name: 'ls_test',
          kind: 'lookup',
          rules,
          rulesDigest,
          profiles: [
            {
              id: OUTPUT_LOOKUP_PROFILE,
              authentication,
              payment: 'none',
              maxRequestBytes: 1048576,
              maxResponseBytes: 65536,
              parameters: {
                sessionSeconds: '300',
                replaySeconds: '600',
                maxObservations: 10,
                maxWaitMs: 25000
              }
            }
          ]
        }
      ]
    },
    key
  )
  const { record, selection } = retainOutputCapability(signed, request)
  const scope = {
    chain,
    provider: authentication === 'brc103' ? identity : 'https://example.test',
    service: 'ls_test',
    queryDigest: outputPacketDigest('lookup-query', {
      service: opening.service,
      query: opening.query
    }),
    rulesDigest,
    access: 'public',
    epoch: 'epoch-1'
  }
  const snapshot: OutputLookupBatch = {
    version: 1,
    session: 'session-1',
    scope,
    phase: 'snapshot',
    groups: [],
    cursor: 'cursor-1',
    snapshotComplete: true,
    through: '4',
    highWater: '4',
    expiresAt: '1300',
    replayUntil: '1900',
    limits
  }
  const live: OutputLookupBatch = {
    ...snapshot,
    phase: 'live',
    cursor: 'cursor-2',
    through: '6',
    highWater: '6',
    groups: [
      {
        id: 'live/6',
        sequence: '6',
        observations: [
          {
            id: 'live/6/withdraw',
            scope,
            kind: 'withdraw',
            payload: {
              outpoint: { chain, txid: '02'.repeat(32), outputIndex: 0 },
              reason: 'evicted'
            }
          }
        ]
      }
    ]
  }
  const response = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(typeof value === 'string' ? value : JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', ...selection.headers, ...headers }
    })
  const fetchClient = jest.fn<typeof fetch>().mockImplementation(async () => response(snapshot))
  const options: OutputLookupTransportOptions = {
    contract: record,
    trust: request,
    now: () => '1000',
    fetch: fetchClient,
    ...overrides
  }
  return {
    client: new OutputLookupTransport(options),
    options,
    record,
    request,
    selection,
    snapshot,
    live,
    response,
    fetchClient
  }
}

describe('retained BRC-193 lookup transport', () => {
  it('uses whole Unix seconds from the default clock and rejects the expiry boundary', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_299_999)
    const f = setup({ now: undefined })
    expect(await f.client.open(opening)).toEqual(f.snapshot)
    clock.mockReturnValue(1_300_000)
    await expect(f.client.read(f.snapshot, limits)).rejects.toMatchObject({ code: 'reset-required' })
    expect(f.fetchClient).toHaveBeenCalledTimes(1)
  })

  it.each(['URL', 'Request'] as const)(
    'bounds the authentication dependency when it passes a %s instead of a string',
    async representation => {
      const f = setup({ wallet: new CompletedProtoWallet(new PrivateKey(43)) }, 'brc103')
      const url = 'https://example.test/.well-known/auth'
      const input = representation === 'URL' ? new URL(url) : new Request(url)
      const stop = new Error('Authentication dependency fixture finished')
      // Exercise the dependency's public fetch port. Actual handshake/signature
      // completion is covered separately by the real HTTP integration fixture.
      const send = jest
        .spyOn(SimplifiedFetchTransport.prototype, 'send')
        .mockImplementation(async function (this: SimplifiedFetchTransport, message) {
          expect(message.messageType).toBe('initialRequest')
          const response = await this.fetchClient(input, { method: 'POST' })
          expect(await response.json()).toEqual(f.snapshot)
          throw stop
        })
      await expect(f.client.open(opening)).rejects.toBe(stop)
      expect(send).toHaveBeenCalledTimes(1)
      expect(f.fetchClient).toHaveBeenCalledWith(
        input,
        expect.objectContaining({
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          signal: expect.any(AbortSignal)
        })
      )
    }
  )

  it('rejects an authentication dependency changing the endpoint before dispatch', async () => {
    const f = setup({ wallet: new CompletedProtoWallet(new PrivateKey(43)) }, 'brc103')
    const send = jest
      .spyOn(SimplifiedFetchTransport.prototype, 'send')
      .mockImplementation(async function (this: SimplifiedFetchTransport) {
        await this.fetchClient(new URL('https://other.test/.well-known/auth'))
      })
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(f.fetchClient).not.toHaveBeenCalled()
  })

  it('gives an injected native-style Fetch the global receiver', async () => {
    const f = setup()
    const nativeStyleFetch: typeof fetch = async function (this: typeof globalThis, input, init) {
      if (this !== globalThis)
        throw new TypeError('Illegal invocation: Fetch requires its global receiver')
      expect(input).toBe('https://example.test/tenant/api/overlay/v1/lookup/open')
      expect(init?.redirect).toBe('error')
      return f.response(f.snapshot)
    }
    const client = new OutputLookupTransport({ ...f.options, fetch: nativeStyleFetch })
    expect(await client.open(opening)).toEqual(f.snapshot)
  })

  it('resumes from an owned compact receipt boundary without duplicating evidence bytes', async () => {
    const f = setup()
    const batch = structuredClone(f.snapshot)
    const checkpoint = outputLookupCheckpoint(batch)
    expect(checkpoint).toEqual({
      version: 1,
      session: batch.session,
      scope: batch.scope,
      phase: batch.phase,
      cursor: batch.cursor,
      snapshotComplete: batch.snapshotComplete,
      through: batch.through,
      highWater: batch.highWater,
      expiresAt: batch.expiresAt,
      replayUntil: batch.replayUntil
    })
    expect(parseOutputLookupCheckpoint(JSON.stringify(checkpoint))).toEqual(checkpoint)
    batch.scope.access = 'mutated'
    expect(checkpoint.scope.access).toBe('public')
    f.fetchClient.mockImplementation(async () => f.response(f.live))
    expect(await f.client.readCheckpoint(checkpoint, limits)).toEqual(f.live)
    expect(JSON.parse(f.fetchClient.mock.calls[0][1]!.body as string)).toEqual({
      version: 1,
      session: checkpoint.session,
      cursor: checkpoint.cursor,
      limits
    })
  })

  it.each([
    { through: '5', highWater: '4' },
    { expiresAt: '1901' },
    { phase: 'live', snapshotComplete: false },
    { cursor: '' },
    { groups: [] },
    { version: 2 },
    { highWater: '18446744073709551616' }
  ])('rejects corrupt compact receipt metadata before fetching: %j', async update => {
    const f = setup()
    const checkpoint = { ...outputLookupCheckpoint(f.snapshot), ...update }
    expect(() => parseOutputLookupCheckpoint(checkpoint)).toThrow()
    await expect(f.client.readCheckpoint(checkpoint, limits)).rejects.toThrow()
    expect(f.fetchClient).not.toHaveBeenCalled()
  })

  it('bounds serialized checkpoint bytes and retains incomplete-snapshot state', () => {
    const f = setup()
    const checkpoint = outputLookupCheckpoint({ ...f.snapshot, snapshotComplete: false })
    expect(parseOutputLookupCheckpoint(checkpoint).snapshotComplete).toBe(false)
    expect(() =>
      parseOutputLookupCheckpoint(' '.repeat(16384) + JSON.stringify(checkpoint))
    ).toThrow('byte limit')
    const live = outputLookupCheckpoint(f.live)
    expect(parseOutputLookupCheckpoint(live)).toEqual(live)
  })

  it('requires mutual authentication, exact peer identity and payment denial on every authenticated call', async () => {
    const wallet = new CompletedProtoWallet(new PrivateKey(43))
    const f = setup({ wallet }, 'brc103')
    const send = jest
      .spyOn(AuthFetch.prototype, 'fetch')
      .mockImplementation(async () => f.response(f.snapshot))
    expect(await f.client.open(opening)).toEqual(f.snapshot)
    expect(send).toHaveBeenCalledWith(
      'https://example.test/tenant/api/overlay/v1/lookup/open',
      expect.objectContaining({
        method: 'POST',
        requireMutualAuth: true,
        expectedIdentityKey: identity,
        allowPayments: false
      })
    )
    expect(f.fetchClient).not.toHaveBeenCalled()
    send.mockImplementation(async () => f.response({}, 402))
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('appends endpoints to the path and sends an owned request with explicit transport policy', async () => {
    const f = setup()
    const request = structuredClone(opening)
    const pending = f.client.open(request)
    request.query.text = 'mutated'
    f.record.manifest.body.baseURL = 'https://other.test'
    f.record.manifest.body.identity = new PrivateKey(72).toPublicKey().toString()
    expect(await pending).toEqual(f.snapshot)
    expect(f.fetchClient).toHaveBeenCalledTimes(1)
    const [url, init] = f.fetchClient.mock.calls[0]
    expect(url).toBe('https://example.test/tenant/api/overlay/v1/lookup/open')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit'
    })
    expect(JSON.parse(init!.body as string)).toEqual(opening)
    expect(new Headers(init!.headers).get('cache-control')).toBe('no-store')
    expect(new Headers(init!.headers).get('x-bsv-overlay-capability')).toBe(f.selection.digest)
    expect(new Headers(init!.headers).get('x-bsv-overlay-profile')).toBe(OUTPUT_LOOKUP_PROFILE)
  })

  it('reads only from the supplied committed boundary and leaves retry/commit decisions to its caller', async () => {
    const f = setup()
    f.fetchClient.mockImplementation(async () => f.response(f.live))
    const previous = structuredClone(f.snapshot)
    const pending = f.client.read(previous, limits)
    previous.cursor = 'uncommitted-change'
    expect(await pending).toEqual(f.live)
    expect(await f.client.read(f.snapshot, limits)).toEqual(f.live)
    expect(f.fetchClient.mock.calls.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
      { version: 1, session: f.snapshot.session, cursor: f.snapshot.cursor, limits },
      { version: 1, session: f.snapshot.session, cursor: f.snapshot.cursor, limits }
    ])
  })

  it('recovers original sessions after manifest expiry without replacing the contract', async () => {
    const f = setup({ now: () => '1200' })
    f.fetchClient.mockImplementation(async () => f.response(f.live))
    expect(await f.client.read(f.snapshot, limits)).toEqual(f.live)
  })

  it('clamps all requested limits and requires the exact negotiated response', async () => {
    const f = setup()
    const requested = { maxBytes: 4294967295, maxObservations: 4294967295, waitMs: 4294967295 }
    const expected = { maxBytes: 65536, maxObservations: 10, waitMs: 25000 }
    f.fetchClient.mockImplementation(async () => f.response({ ...f.snapshot, limits: expected }))
    expect((await f.client.open({ ...opening, limits: requested })).limits).toEqual(expected)
    f.fetchClient.mockImplementation(async () =>
      f.response({ ...f.snapshot, limits: { ...limits, maxBytes: 65535 } })
    )
    await expect(f.client.open(opening)).rejects.toThrow('negotiated limits')
  })

  it('returns structured authenticated-profile errors even when the requested byte allowance is tiny', async () => {
    const f = setup()
    const packet = {
      version: 1,
      error: {
        code: 'limited',
        message: 'Next group exceeds allowance',
        retryable: false,
        limit: { kind: 'group', minimumBytes: 65536, minimumObservations: 2 }
      }
    }
    f.fetchClient.mockImplementation(async () => f.response(packet, 413))
    const result = f.client.open({ ...opening, limits: { ...limits, maxBytes: 1 } })
    await expect(result).rejects.toBeInstanceOf(OutputLookupServiceError)
    await expect(result).rejects.toMatchObject({ code: 'limited', retryable: false, packet })
    expect(f.fetchClient).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'status',
      400,
      { version: 1, error: { code: 'unavailable', message: 'Unavailable', retryable: true } },
      'status mismatch'
    ],
    ['payment', 402, {}, 'cannot request payment'],
    ['oversized error', 503, ' '.repeat(4097), 'body limit'],
    [
      'invalid error',
      503,
      { version: 1, error: { code: 'cancelled', message: 'Local only', retryable: true } },
      'tag'
    ],
    [
      'no cursor on error',
      413,
      {
        version: 1,
        cursor: 'next',
        error: { code: 'limited', message: 'Limited', retryable: true }
      },
      'Unknown'
    ]
  ])('rejects %s without retry or success', async (_name, status, body, message) => {
    const f = setup()
    f.fetchClient.mockImplementation(async () => f.response(body, status as number))
    await expect(f.client.open(opening)).rejects.toThrow(message as string)
    expect(f.fetchClient).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['provider', { provider: 'https://other.test' }],
    ['chain', { chain: { ...chain, network: 'other' } }],
    ['rules', { rulesDigest: '03'.repeat(32) }],
    ['service', { service: 'ls_other' }],
    ['query', { queryDigest: '04'.repeat(32) }]
  ])('rejects an opening with changed %s', async (_name, scope) => {
    const f = setup()
    f.fetchClient.mockImplementation(async () =>
      f.response({ ...f.snapshot, scope: { ...f.snapshot.scope, ...scope } })
    )
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'context-changed' })
  })

  it.each([
    ['live opening', { phase: 'live' }],
    ['expired', { expiresAt: '1000', replayUntil: '1600' }],
    ['wrong retention', { replayUntil: '1901' }],
    ['duplicate JSON field', '{"version":1,"version":1}']
  ])('rejects %s', async (_name, update) => {
    const f = setup()
    f.fetchClient.mockImplementation(async () =>
      f.response(typeof update === 'string' ? update : { ...f.snapshot, ...update })
    )
    await expect(f.client.open(opening)).rejects.toThrow()
  })

  it.each([
    ['capability', { 'x-bsv-overlay-capability': '00'.repeat(32) }],
    ['profile', { 'x-bsv-overlay-profile': 'urn:other' }],
    ['compression', { 'content-encoding': 'gzip' }],
    ['oversized headers', { 'x-padding': 'x'.repeat(16384) }]
  ])('rejects %s before observations are returned', async (_name, headers) => {
    const f = setup()
    f.fetchClient.mockImplementation(async () => f.response(f.snapshot, 200, headers))
    await expect(f.client.open(opening)).rejects.toThrow()
  })

  it('validates the actual JSON bytes independently of an unsigned response MIME label', async () => {
    const f = setup()
    f.fetchClient.mockImplementation(async () =>
      f.response(f.snapshot, 200, { 'content-type': 'application/octet-stream' })
    )
    expect(await f.client.open(opening)).toEqual(f.snapshot)
    f.fetchClient.mockImplementation(async () =>
      f.response('<html>not JSON</html>', 200, { 'content-type': 'application/json' })
    )
    await expect(f.client.open(opening)).rejects.toThrow()
  })

  it('bounds original UTF-8 bytes, including whitespace, without trusting Content-Length', async () => {
    const f = setup()
    f.fetchClient.mockImplementation(async () =>
      f.response(' '.repeat(65536) + JSON.stringify(f.snapshot), 200, { 'content-length': '1' })
    )
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'limited' })
    f.fetchClient.mockImplementation(async () =>
      f.response(f.snapshot, 200, { 'content-length': '65537' })
    )
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'limited' })
  })

  it('rejects invalid UTF-8 rather than silently replacing it', async () => {
    const f = setup()
    f.fetchClient.mockImplementation(
      async () =>
        new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]), {
          headers: { 'content-type': 'application/json', ...f.selection.headers }
        })
    )
    await expect(f.client.open(opening)).rejects.toThrow('Malformed UTF-8')
  })

  it('rejects redirects and endpoints changed by an injected fetch', async () => {
    const f = setup()
    const moved = f.response(f.snapshot)
    Object.defineProperty(moved, 'url', { value: 'https://other.test' })
    f.fetchClient.mockResolvedValueOnce(moved)
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'unauthorized' })
    const redirected = f.response(f.snapshot)
    Object.defineProperty(redirected, 'redirected', { value: true })
    f.fetchClient.mockResolvedValueOnce(redirected)
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it.each([
    { cursor: 'next', session: 'changed' },
    { expiresAt: '1301', replayUntil: '1901' },
    { phase: 'snapshot' },
    { scope: { access: 'other' } }
  ])('rejects session discontinuity instead of reporting empty success: %j', async update => {
    const f = setup()
    f.fetchClient.mockImplementation(async () =>
      f.response({ ...f.live, ...update, groups: [], scope: { ...f.live.scope, ...update.scope } })
    )
    await expect(f.client.read(f.snapshot, limits)).rejects.toThrow()
  })

  it('checks current expiry before sending and again after receiving', async () => {
    let now = '1000'
    const f = setup({ now: () => now })
    f.fetchClient.mockImplementation(async () => {
      now = '1300'
      return f.response(f.live)
    })
    await expect(f.client.read(f.snapshot, limits)).rejects.toMatchObject({
      code: 'reset-required'
    })
    await expect(f.client.read(f.snapshot, limits)).rejects.toMatchObject({
      code: 'reset-required'
    })
    expect(f.fetchClient).toHaveBeenCalledTimes(1)
  })

  it('checks local input and the saved contract before network I/O', async () => {
    const f = setup()
    await expect(f.client.open({ ...opening, service: 'wrong' })).rejects.toMatchObject({
      code: 'context-changed'
    })
    await expect(
      f.client.open({ ...opening, requiredRulesDigest: '02'.repeat(32) })
    ).rejects.toMatchObject({ code: 'context-changed' })
    await expect(f.client.open({ ...opening, query: 'x'.repeat(1048576) })).rejects.toMatchObject({
      code: 'limited'
    })
    await expect(
      f.client.read({ ...f.snapshot, scope: { ...f.snapshot.scope, provider: 'other' } }, limits)
    ).rejects.toMatchObject({ code: 'context-changed' })
    expect(f.fetchClient).not.toHaveBeenCalled()
    expect(() => setup({ requestTimeoutMs: 30001 })).toThrow('deadline')
    expect(() => setup({ requestTimeoutMs: 0 })).toThrow('deadline')
    expect(() => setup({}, 'brc103')).toThrow('wallet')
    expect(() => setup({ trust: { ...f.request, service: 'wrong' } })).toThrow('selection changed')
    expect(() => setup({ trust: { ...f.request, profile: 'urn:wrong' } })).toThrow('profile')
    const corrupt = structuredClone(f.record)
    corrupt.digest = '00'.repeat(32)
    expect(() => setup({ contract: corrupt })).toThrow('digest changed')
  })

  it('closes after expiry, verifies the response, and does not invent an existence result', async () => {
    const f = setup({ now: () => '2000' })
    f.fetchClient.mockImplementation(async () => f.response({ version: 1, closed: true }))
    expect(await f.client.close('unknown-session')).toEqual({ version: 1, closed: true })
    expect(await f.client.close('unknown-session')).toEqual({ version: 1, closed: true })
    const [url, init] = f.fetchClient.mock.calls[0]
    expect(url).toBe('https://example.test/tenant/api/overlay/v1/lookup/close')
    expect(JSON.parse(init!.body as string)).toEqual({ version: 1, session: 'unknown-session' })
    f.fetchClient.mockImplementation(async () => f.response({ version: 1, closed: false }))
    await expect(f.client.close('unknown-session')).rejects.toThrow()
  })

  it('cancels before I/O and keeps late non-cancellable fetch work bounded after cancellation', async () => {
    const f = setup()
    const cancelled = AbortSignal.abort()
    await expect(f.client.open(opening, cancelled)).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.fetchClient).not.toHaveBeenCalled()
    let finish!: (response: Response) => void
    f.fetchClient.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const controller = new AbortController()
    const pending = f.client.open(opening, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'limited' })
    expect(f.fetchClient).toHaveBeenCalledTimes(1)
    const cancelBody = jest.fn()
    const late = new Response(new ReadableStream({ cancel: cancelBody }), {
      headers: { 'content-type': 'application/json' }
    })
    finish(late)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cancelBody).toHaveBeenCalledTimes(1)
    expect(await f.client.open(opening)).toEqual(f.snapshot)
  })

  it('releases a deadline waiter while retaining outstanding I/O capacity until settlement', async () => {
    const f = setup({ requestTimeoutMs: 10 })
    let finish!: (response: Response) => void
    f.fetchClient.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    await expect(f.client.open(opening)).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true
    })
    await expect(f.client.open(opening)).rejects.toMatchObject({ code: 'limited' })
    finish(f.response(f.snapshot))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await f.client.open(opening)).toEqual(f.snapshot)
  })

  it('cancels a stalled response stream rather than buffering or advancing a cursor', async () => {
    const f = setup()
    const cancel = jest.fn()
    f.fetchClient.mockImplementationOnce(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'application/json', ...f.selection.headers }
        })
    )
    const controller = new AbortController()
    const pending = f.client.open(opening, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await f.client.open(opening)).toEqual(f.snapshot)
  })
})
