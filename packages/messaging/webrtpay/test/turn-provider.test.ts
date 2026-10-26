import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { WebSocket } from 'ws'
import type { RelayServer } from '../server/index.js'
import { turnCredentials, turnIssuer } from '../server/turn.js'
import type { CloudflareTurnProvider, TurnProvider } from '../server/turn.js'
import { RelaySignaler } from '../src/signaling/RelaySignaler.js'
import { authenticate, env, party, relayFixtures, waitFor } from './helpers/relay.js'
import type { Party, Raw } from './helpers/relay.js'

/*
 * TURN credential providers: coturn REST and Cloudflare Realtime TURN. Cloudflare is never
 * called: every test hands the provider a mock `fetch`.
 */

const KEY_ID = '0123456789abcdef0123456789abcdef'
/** Stands in for the API token; no frame, log line or error message may contain it. */
const API_TOKEN = 'cf-secret-token-' + 'Z'.repeat(48)
/** Cloudflare credentials are 96 hex characters each, with no expiry inside. */
const USERNAME = 'ab'.repeat(48)
const CREDENTIAL = 'cd'.repeat(48)
const GENERATE_URL = `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`
const T0 = 1_790_000_000_000

const CF_STUN = 'stun:stun.cloudflare.com:3478'
const CF_TURN = [
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:443?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turn:turn.cloudflare.com:80?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
  'turns:turn.cloudflare.com:443?transport=tcp'
]

/** The documented response today: a STUN entry, then a TURN entry with the credentials. */
const CURRENT = {
  iceServers: [{ urls: [CF_STUN] }, { urls: CF_TURN, username: USERNAME, credential: CREDENTIAL }]
}

/** The response until 2025: one entry mixing STUN and TURN, with port 53 alternates. */
const COMBINED = {
  iceServers: [
    {
      urls: [
        CF_STUN,
        'stun:stun.cloudflare.com:53',
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp'
      ],
      username: USERNAME,
      credential: CREDENTIAL
    }
  ]
}

/** What the relay hands out for `CURRENT`. */
const ISSUED = [{ urls: [CF_STUN] }, { urls: CF_TURN, username: USERNAME, credential: CREDENTIAL }]

function json(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

type Fetch = typeof globalThis.fetch

/** A mock `fetch` answering with `respond`, and the requests it saw. */
function mockFetch(respond: (init: RequestInit) => Response | Promise<Response>): {
  fetch: jest.Mock<Fetch>
  requests: Array<{ url: string; init: RequestInit }>
} {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetch = jest.fn<Fetch>(async (input, init = {}) => {
    requests.push({ url: String(input), init })
    return respond(init)
  })
  return { fetch, requests }
}

function cloudflare(fetch: Fetch, o: Partial<CloudflareTurnProvider> = {}): CloudflareTurnProvider {
  return { kind: 'cloudflare', keyId: KEY_ID, apiToken: API_TOKEN, fetch, ...o }
}

/** Throws `e`, whatever it is, for a mock that fails. */
function throwing(e: unknown): never {
  throw e
}

/** A promise with its resolve function. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

describe('turnIssuer: coturn REST', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('issues turnCredentials for the urls, expiring with them', async () => {
    jest.useFakeTimers({ now: T0 })
    const urls = ['turn:a.example:3478', 'turns:a.example:5349']
    const issuer = turnIssuer({ kind: 'coturn-rest', secret: 's', urls, ttlSeconds: 60 })
    expect(issuer).toMatchObject({ kind: 'coturn-rest', ttlSeconds: 60 })
    const { username, credential, expiresAt } = turnCredentials({
      secret: 's',
      identityKey: '02ab',
      ttlSeconds: 60,
      now: T0
    })
    expect(await issuer.issue('02ab')).toEqual({
      iceServers: [{ urls, username, credential }],
      expiresAt
    })
    expect(expiresAt).toBe(T0 + 60_000)
  })

  it('defaults to 600 s, as the relay always has', async () => {
    jest.useFakeTimers({ now: T0 })
    const issuer = turnIssuer({ kind: 'coturn-rest', secret: 's', urls: ['turn:a.example:3478'] })
    expect(issuer.ttlSeconds).toBe(600)
    expect((await issuer.issue('02ab')).expiresAt).toBe(T0 + 600_000)
  })

  it('rejects, never throws, when credentials cannot be made', async () => {
    const issuer = turnIssuer({ kind: 'coturn-rest', secret: 's', urls: ['turn:a.example:3478'] })
    // A symbol cannot become part of the HMAC input; the relay chains `.then` on `issue`.
    const issuing = issuer.issue(Symbol('key') as unknown as string)
    await expect(issuing).rejects.toBeInstanceOf(TypeError)
  })

  it('refuses a provider it cannot issue for when it is made', () => {
    const urls = ['turn:a.example:3478']
    expect(() => turnIssuer({ kind: 'coturn-rest', secret: '', urls })).toThrow(TypeError)
    expect(() => turnIssuer({ kind: 'coturn-rest', secret: 's', urls: [] })).toThrow(
      'turn.urls must list at least one TURN url'
    )
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN]) {
      expect(() => turnIssuer({ kind: 'coturn-rest', secret: 's', urls, ttlSeconds })).toThrow(
        RangeError
      )
    }
    for (const kind of [undefined, 'coturn', 'twilio']) {
      expect(() => turnIssuer({ kind, secret: 's', urls } as unknown as TurnProvider)).toThrow(
        "turn.kind must be 'coturn-rest' or 'cloudflare'"
      )
    }
  })
})

describe('turnIssuer: Cloudflare', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('posts the ttl with the API token and computes expiresAt from the time it asked', async () => {
    jest.useFakeTimers({ now: T0 })
    const { fetch, requests } = mockFetch(() => {
      // the answer takes 2 s: credentials count from the request, never from the answer
      jest.setSystemTime(T0 + 2000)
      return json(CURRENT)
    })
    const issuer = turnIssuer(cloudflare(fetch))
    expect(issuer).toMatchObject({ kind: 'cloudflare', ttlSeconds: 600 })
    expect(await issuer.issue('02ab')).toEqual({ iceServers: ISSUED, expiresAt: T0 + 600_000 })

    expect(requests).toHaveLength(1)
    const [{ url, init }] = requests
    expect(url).toBe(GENERATE_URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': 'application/json'
    })
    // the identity key is never sent to Cloudflare
    expect(init.body).toBe('{"ttl":600}')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('accepts 200 as well as 201', async () => {
    const { fetch } = mockFetch(() => json(CURRENT, 200))
    expect((await turnIssuer(cloudflare(fetch)).issue('02ab')).iceServers).toEqual(ISSUED)
  })

  it('splits the older combined entry into STUN and TURN, without port 53', async () => {
    const { fetch } = mockFetch(() => json(COMBINED))
    expect((await turnIssuer(cloudflare(fetch)).issue('02ab')).iceServers).toEqual([
      { urls: [CF_STUN] },
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turn:turn.cloudflare.com:80?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
          'turns:turn.cloudflare.com:443?transport=tcp'
        ],
        username: USERNAME,
        credential: CREDENTIAL
      }
    ])
  })

  it('reads an iceServers object as well as a list, and drops what is not STUN or TURN', async () => {
    const { fetch } = mockFetch(() =>
      json({
        iceServers: {
          urls: [...CF_TURN, 'https://example.com', 'turn:turn.cloudflare.com:53', 42],
          username: USERNAME,
          credential: CREDENTIAL
        }
      })
    )
    expect((await turnIssuer(cloudflare(fetch)).issue('02ab')).iceServers).toEqual([
      { urls: CF_TURN, username: USERNAME, credential: CREDENTIAL }
    ])
  })

  it('caps the ttl at 48 hours, and expiresAt with it', async () => {
    jest.useFakeTimers({ now: T0 })
    const { fetch, requests } = mockFetch(() => json(CURRENT))
    const issuer = turnIssuer(cloudflare(fetch, { ttlSeconds: 864000 }))
    expect(issuer.ttlSeconds).toBe(172800)
    expect((await issuer.issue('02ab')).expiresAt).toBe(T0 + 172_800_000)
    expect(requests[0].init.body).toBe('{"ttl":172800}')
  })

  it('rejects, naming no secret, when Cloudflare refuses or answers something unusable', async () => {
    const answers: Array<[string, () => Response | Promise<Response>]> = [
      ['HTTP 500', () => new Response(`internal error for ${API_TOKEN}`, { status: 500 })],
      ['HTTP 401', () => json({ error: 'bad token', token: API_TOKEN }, 401)],
      ['HTTP 204', () => new Response(null, { status: 204 })],
      ['not JSON', () => new Response(`<html>${USERNAME}</html>`, { status: 201 })],
      ['no ICE servers', () => json({ result: CURRENT })],
      ['no TURN server', () => json({ iceServers: [{ urls: [CF_STUN] }] })],
      [
        'no TURN server',
        () => json({ iceServers: [{ urls: CF_TURN, username: USERNAME, credential: '' }] })
      ],
      ['no TURN server', () => json({ iceServers: [{ urls: CF_TURN }] })],
      ['no TURN server', () => json({ iceServers: [{ urls: ['turn:turn.cloudflare.com:53'] }] })],
      [
        'request failed',
        () => {
          throw new TypeError(`fetch failed: ${GENERATE_URL} Bearer ${API_TOKEN}`)
        }
      ]
    ]
    for (const [reason, answer] of answers) {
      const { fetch } = mockFetch(answer)
      const failure = await turnIssuer(cloudflare(fetch))
        .issue('02ab')
        .then(
          () => undefined,
          (e: unknown) => e
        )
      expect([reason, failure]).toEqual([reason, expect.any(Error)])
      const message = (failure as Error).message
      expect([reason, message]).toEqual([reason, expect.stringContaining(reason)])
      for (const secret of [API_TOKEN, KEY_ID, USERNAME, CREDENTIAL]) {
        expect(message).not.toContain(secret)
      }
    }
  })

  it('aborts a request that takes 5 s', async () => {
    jest.useFakeTimers({ now: T0 })
    let signal: AbortSignal | undefined
    const fetch = jest.fn<Fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined
          signal?.addEventListener('abort', () => reject(new Error(`aborted ${API_TOKEN}`)))
        })
    )
    const issued = turnIssuer(cloudflare(fetch)).issue('02ab')
    const settled = jest.fn()
    issued.then(settled, settled)
    await jest.advanceTimersByTimeAsync(4999)
    expect(settled).not.toHaveBeenCalled()
    expect(signal?.aborted).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await expect(issued).rejects.toThrow('no answer within 5 s')
    expect(signal?.aborted).toBe(true)
  })

  it('gives up at 5 s on a fetch that ignores the abort, and on a body that never ends', async () => {
    jest.useFakeTimers({ now: T0 })
    const never = new Promise<Response>(() => {})
    const stalledBody = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"iceServers":'))
        }
      }),
      { status: 201 }
    )
    for (const answer of [() => never, () => stalledBody]) {
      const { fetch } = mockFetch(answer)
      const issued = turnIssuer(cloudflare(fetch)).issue('02ab')
      const expectation = expect(issued).rejects.toThrow('no answer within 5 s')
      await jest.advanceTimersByTimeAsync(5000)
      await expectation
    }
  })

  it('adds a short allow-listed diagnostic to a failed request, never what the error says', async () => {
    const withCause = (message: string, code: unknown): Error =>
      Object.assign(new TypeError(message), {
        cause: Object.assign(new Error(`connect failed ${GENERATE_URL}`), { code })
      })
    const named = (name: unknown): Error => Object.assign(new Error(`x ${API_TOKEN}`), { name })
    const leaky = `fetch failed ${GENERATE_URL} Bearer ${API_TOKEN}`
    const cases: Array<[string, () => never, string]> = [
      ['a system error code', () => throwing(withCause(leaky, 'ECONNREFUSED')), 'ECONNREFUSED'],
      [
        'an undici code',
        () => throwing(withCause(leaky, 'UND_ERR_CONNECT_TIMEOUT')),
        'UND_ERR_CONNECT_TIMEOUT'
      ],
      ['the name, with no cause', () => throwing(new TypeError(leaky)), 'TypeError'],
      ['the name of an abort', () => throwing(named('AbortError')), 'AbortError'],
      [
        'the name when the code is not allow-listed',
        () => throwing(withCause(leaky, `connect ${GENERATE_URL}`)),
        'TypeError'
      ],
      [
        'the name when the code is lowercase',
        () => throwing(withCause(leaky, 'econnrefused')),
        'TypeError'
      ],
      ['the name when the code is a number', () => throwing(withCause(leaky, 503)), 'TypeError'],
      [
        'the name when the code is over 40 characters',
        () => throwing(withCause(leaky, 'E'.repeat(41))),
        'TypeError'
      ],
      ['nothing for a bare Error', () => throwing(new Error(leaky)), ''],
      ['nothing for a name that is the token', () => throwing(named(API_TOKEN)), ''],
      ['nothing for a name that is not letters', () => throwing(named('Fetch-Error')), ''],
      [
        'a name of 40 letters and Error',
        () => throwing(named('A'.repeat(40) + 'Error')),
        'A'.repeat(40) + 'Error'
      ],
      [
        'nothing for a name of 41 letters and Error',
        () => throwing(named('A'.repeat(41) + 'Error')),
        ''
      ],
      ['nothing for a thrown string', () => throwing(leaky), ''],
      ['nothing for a thrown null', () => throwing(null), ''],
      [
        'nothing for an error whose properties throw',
        () =>
          throwing(
            Object.defineProperty(new Error(leaky), 'cause', {
              get() {
                throw new Error(leaky)
              }
            })
          ),
        ''
      ]
    ]
    for (const [label, fail, diagnostic] of cases) {
      const { fetch } = mockFetch(fail)
      const failure = await turnIssuer(cloudflare(fetch))
        .issue('02ab')
        .then(
          () => undefined,
          (e: unknown) => e
        )
      const expected = `Cloudflare TURN: request failed${diagnostic === '' ? '' : ` (${diagnostic})`}`
      expect([label, (failure as Error | undefined)?.message]).toEqual([label, expected])
      expect(failure).toBeInstanceOf(Error)
      for (const secret of [API_TOKEN, KEY_ID, GENERATE_URL]) {
        expect((failure as Error).message).not.toContain(secret)
      }
    }
  })

  it('reads an answer of 64 KiB but not one byte more', async () => {
    const padded = (bytes: number): string => {
      const text = JSON.stringify(CURRENT)
      return text + ' '.repeat(bytes - Buffer.byteLength(text))
    }
    const at = mockFetch(() => new Response(padded(65536), { status: 201 }))
    expect((await turnIssuer(cloudflare(at.fetch)).issue('02ab')).iceServers).toEqual(ISSUED)
    const over = mockFetch(() => new Response(padded(65537), { status: 201 }))
    await expect(turnIssuer(cloudflare(over.fetch)).issue('02ab')).rejects.toThrow(
      'Cloudflare TURN: the answer is too large'
    )
  })

  it('refuses an answer whose content-length is over 64 KiB without reading it', async () => {
    let read = false
    let cancelled = false
    // a high water mark of 0: nothing is pulled until something reads
    const body = new ReadableStream(
      {
        pull(c) {
          read = true
          c.enqueue(new TextEncoder().encode(JSON.stringify(CURRENT)))
          c.close()
        },
        cancel() {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )
    const { fetch } = mockFetch(
      () => new Response(body, { status: 201, headers: { 'content-length': '65537' } })
    )
    await expect(turnIssuer(cloudflare(fetch)).issue('02ab')).rejects.toThrow('too large')
    expect(cancelled).toBe(true)
    expect(read).toBe(false)
    // a content-length that says nothing usable leaves the streamed limit to decide
    const odd = mockFetch(
      () =>
        new Response(JSON.stringify(CURRENT), {
          status: 201,
          headers: { 'content-length': 'many' }
        })
    )
    expect((await turnIssuer(cloudflare(odd.fetch)).issue('02ab')).iceServers).toEqual(ISSUED)
  })

  it('stops reading a body without a length once it passes 64 KiB, and releases it', async () => {
    let pulls = 0
    let cancelled = false
    const endless = new ReadableStream({
      async pull(c) {
        pulls++
        // a network body arrives in turns of the event loop, which the deadline's timer needs
        await new Promise(res => setTimeout(res, 1))
        c.enqueue(new Uint8Array(8192).fill(0x20))
        // long enough to show the limit works, and it ends, so a missing limit cannot hang
        if (pulls === 100) c.close()
      },
      cancel() {
        cancelled = true
      }
    })
    const { fetch } = mockFetch(() => new Response(endless, { status: 201 }))
    // real timers: it must give up on size, long before the 5 s deadline
    const started = Date.now()
    await expect(turnIssuer(cloudflare(fetch)).issue('02ab')).rejects.toThrow('too large')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(cancelled).toBe(true)
    // 8 chunks make 64 KiB; the 9th is over. The stream may have been pulled one ahead.
    expect(pulls).toBeLessThanOrEqual(10)
  })

  it('forwards at most 8 TURN urls, the first ones Cloudflare lists', async () => {
    const urls = (n: number, port = 3478): string[] =>
      Array.from({ length: n }, (_, i) => `turn:turn.cloudflare.com:${port + i}?transport=udp`)
    const one = mockFetch(() =>
      json({
        iceServers: [
          { urls: [CF_STUN] },
          { urls: urls(12), username: USERNAME, credential: CREDENTIAL }
        ]
      })
    )
    expect((await turnIssuer(cloudflare(one.fetch)).issue('02ab')).iceServers).toEqual([
      { urls: [CF_STUN] },
      { urls: urls(8), username: USERNAME, credential: CREDENTIAL }
    ])
    // the limit counts every entry together; an entry with no room left is dropped
    const many = mockFetch(() =>
      json({
        iceServers: [
          { urls: urls(6), username: USERNAME, credential: CREDENTIAL },
          { urls: urls(6, 4000), username: 'ef'.repeat(48), credential: 'ab'.repeat(48) },
          { urls: urls(2, 5000), username: 'cd'.repeat(48), credential: 'ef'.repeat(48) }
        ]
      })
    )
    const issued = (await turnIssuer(cloudflare(many.fetch)).issue('02ab')).iceServers
    expect(issued).toEqual([
      { urls: urls(6), username: USERNAME, credential: CREDENTIAL },
      { urls: urls(2, 4000), username: 'ef'.repeat(48), credential: 'ab'.repeat(48) }
    ])
    // the six Cloudflare lists today are not touched
    const today = mockFetch(() => json(CURRENT))
    expect((await turnIssuer(cloudflare(today.fetch)).issue('02ab')).iceServers).toEqual(ISSUED)
  })

  it('skips entries that are not objects, lists each STUN url once, and caps only TURN urls it forwards', async () => {
    const urls = (n: number, port: number): string[] =>
      Array.from({ length: n }, (_, i) => `turn:turn.cloudflare.com:${port + i}?transport=udp`)
    const { fetch } = mockFetch(() =>
      json({
        iceServers: [
          null,
          'turn:turn.cloudflare.com:3478',
          42,
          [CF_STUN],
          { urls: CF_STUN },
          // without credentials: dropped, and its urls do not count toward the 8
          { urls: [CF_STUN, ...urls(6, 3000)] },
          { urls: [CF_STUN, ...urls(8, 4000)], username: USERNAME, credential: CREDENTIAL }
        ]
      })
    )
    expect((await turnIssuer(cloudflare(fetch)).issue('02ab')).iceServers).toEqual([
      { urls: [CF_STUN] },
      { urls: urls(8, 4000), username: USERNAME, credential: CREDENTIAL }
    ])
  })

  it('refuses a provider it cannot issue for when it is made, naming no secret', () => {
    const { fetch } = mockFetch(() => json(CURRENT))
    const bad: Array<Partial<CloudflareTurnProvider>> = [
      { keyId: '' },
      { keyId: '../../accounts' },
      { keyId: `${KEY_ID}?x=1` },
      { apiToken: '' },
      { apiToken: `${API_TOKEN} ` },
      { apiToken: `${API_TOKEN}\r\nx-injected: 1` },
      { fetch: 42 as unknown as Fetch }
    ]
    for (const o of bad) {
      let thrown: unknown
      try {
        turnIssuer(cloudflare(fetch, o))
      } catch (e) {
        thrown = e
      }
      expect([o, thrown]).toEqual([o, expect.any(TypeError)])
      expect((thrown as Error).message).not.toContain(API_TOKEN)
    }
    for (const ttlSeconds of [0, -1, 1.5]) {
      expect(() => turnIssuer(cloudflare(fetch, { ttlSeconds }))).toThrow(RangeError)
    }
    // nothing is asked of Cloudflare until a client asks for TURN
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('relay with a Cloudflare TURN provider', () => {
  let alice: Party
  let bob: Party
  const { relay, rawAt, signaler, cleanup } = relayFixtures()
  const stun = { urls: ['stun:stun.relay.example:3478'] }

  beforeAll(async () => {
    ;[alice, bob] = await Promise.all([party(), party()])
  })

  afterEach(cleanup)

  /** A relay issuing Cloudflare TURN through `fetch`, and every line it logged. */
  async function cfRelay(
    fetch: Fetch,
    o: Partial<CloudflareTurnProvider> = {},
    limits: Parameters<typeof relay>[0] = {}
  ): Promise<{ r: RelayServer; logs: string[] }> {
    const logs: string[] = []
    const r = await relay({
      stunUrls: stun.urls,
      turn: cloudflare(fetch, o),
      log: line => logs.push(line),
      ...limits
    })
    return { r, logs }
  }

  /** A raw socket authenticated as `p`, past its `ready` and `ice` frames, keeping every frame. */
  async function authed(r: RelayServer, p: Party): Promise<Raw & { seen: unknown[] }> {
    const c = rawAt(r.url)
    const seen: unknown[] = []
    c.ws.on('message', data => seen.push(JSON.parse(String(data))))
    await authenticate(c, p, r.url)
    expect(await c.next()).toEqual({ t: 'ready', identityKey: p.key })
    expect(await c.next()).toEqual({ t: 'ice', iceServers: [stun] })
    return Object.assign(c, { seen })
  }

  async function requestTurn(c: Raw): Promise<Record<string, unknown>> {
    c.send({ t: 'turn' })
    return c.next()
  }

  it('answers turn with its STUN servers, Cloudflare servers and when they expire', async () => {
    const { fetch, requests } = mockFetch(() => json(CURRENT))
    const { r, logs } = await cfRelay(fetch)
    const a = await authed(r, alice)
    const before = Date.now()
    const reply = await requestTurn(a)
    const after = Date.now()
    expect(reply).toEqual({
      t: 'ice',
      iceServers: [stun, ...ISSUED],
      expiresAt: expect.any(Number)
    })
    expect(reply.expiresAt).toBeGreaterThanOrEqual(before + 600_000)
    expect(reply.expiresAt).toBeLessThanOrEqual(after + 600_000)
    expect(requests.map(q => q.init.body)).toEqual(['{"ttl":600}'])
    // the startup log names the provider and never the token
    expect(logs.some(line => line.includes('TURN credentials from cloudflare, valid 600 s'))).toBe(
      true
    )
    expect(JSON.stringify([logs, a.seen])).not.toContain(API_TOKEN)
  })

  it('answers unavailable when Cloudflare fails, keeps the socket and logs no secret', async () => {
    const answers: Array<() => Response> = [
      () => new Response(`no ${API_TOKEN}`, { status: 503 }),
      () => {
        throw new TypeError(`fetch failed: ${GENERATE_URL} Bearer ${API_TOKEN}`)
      },
      () => json({ iceServers: [{ urls: [CF_STUN] }] }),
      () => json(CURRENT)
    ]
    const { fetch } = mockFetch(() => answers.shift()!())
    const { r, logs } = await cfRelay(fetch)
    const a = await authed(r, alice)
    for (let i = 0; i < 3; i++) {
      // a `turn` frame carries no envelope, so there is no `ref` to echo
      expect(await requestTurn(a)).toEqual({ t: 'error', code: 'unavailable' })
    }
    expect((await requestTurn(a)).t).toBe('ice')
    expect(r.stats()).toEqual({ sockets: 1, identities: 1 })
    const failures = logs.filter(line => line.includes('could not get TURN credentials'))
    expect(failures).toHaveLength(3)
    expect(failures[0]).toContain('HTTP 503')
    expect(failures[1]).toContain('request failed (TypeError)')
    expect(failures[2]).toContain('no TURN server')
    for (const secret of [API_TOKEN, KEY_ID, USERNAME, CREDENTIAL]) {
      expect(JSON.stringify(logs)).not.toContain(secret)
    }
    expect(JSON.stringify(a.seen.slice(0, 3))).not.toContain(API_TOKEN)
  })

  it('keeps replies in order while Cloudflare answers, forwarding signals meanwhile', async () => {
    const answer = deferred<void>()
    const { fetch } = mockFetch(async () => {
      await answer.promise
      return json(CURRENT)
    })
    const { r } = await cfRelay(fetch)
    const got: string[] = []
    await signaler(r, bob).listen((_from, e) => got.push(e.sid))
    const a = await authed(r, alice)
    a.send({ t: 'turn' })
    const e = env()
    a.send({ t: 'signal', to: bob.key, envelope: e })
    // the signal is forwarded at once; only its reply waits for the turn reply before it
    await waitFor(() => got.length === 1)
    expect(got).toEqual([e.sid])
    // challenge, ready and ice: neither reply has come
    expect(a.seen).toHaveLength(3)

    answer.resolve()
    expect((await a.next()).t).toBe('ice')
    expect(await a.next()).toEqual({ t: 'sent', ref: e.sid })
  })

  it('drops the answer for a socket that closed while Cloudflare answered', async () => {
    const answer = deferred<void>()
    const { fetch } = mockFetch(async () => {
      await answer.promise
      return json(CURRENT)
    })
    const { r, logs } = await cfRelay(fetch)
    const a = await authed(r, alice)
    a.send({ t: 'turn' })
    await waitFor(() => fetch.mock.calls.length === 1)
    a.ws.close()
    await waitFor(() => r.stats().sockets === 0)
    answer.resolve()
    await new Promise(res => setTimeout(res, 50))
    expect(logs.filter(line => line.includes('could not get TURN credentials'))).toEqual([])

    const b = await authed(r, bob)
    expect((await requestTurn(b)).t).toBe('ice')
  })

  it('spends the per-source and relay-wide budgets before asking Cloudflare', async () => {
    const { fetch } = mockFetch(() => json(CURRENT))
    const { r } = await cfRelay(fetch, {}, { limits: { turnPerIpPerHour: 1 } })
    const a = await authed(r, alice)
    expect((await requestTurn(a)).t).toBe('ice')
    expect(await requestTurn(a)).toEqual({ t: 'error', code: 'rate_limited' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses to start with a provider it cannot issue for', async () => {
    const { fetch } = mockFetch(() => json(CURRENT))
    await expect(cfRelay(fetch, { apiToken: '' })).rejects.toThrow(TypeError)
    await expect(cfRelay(fetch, { keyId: 'a/b' })).rejects.toThrow(TypeError)
  })

  it('gives RelaySignaler expiresAt, which turnProvider reuses the servers until', async () => {
    const { fetch } = mockFetch(() => json(CURRENT))
    const { r } = await cfRelay(fetch)
    const s = signaler(r, alice)
    const provide = s.turnProvider()
    expect(await provide()).toEqual([stun, ...ISSUED])
    expect(await provide()).toEqual([stun, ...ISSUED])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(s.iceServers()).toEqual([stun, ...ISSUED])
  })

  it('makes RelaySignaler ask again for credentials within 30 s of their expiresAt', async () => {
    // 30 s credentials are within the 30 s margin as soon as they arrive. Their usernames
    // hold no expiry, so only the frame's expiresAt can tell the signaler.
    const { fetch } = mockFetch(() => json(CURRENT))
    const { r } = await cfRelay(fetch, { ttlSeconds: 30 })
    const s = signaler(r, alice)
    const provide = s.turnProvider()
    expect(await provide()).toEqual([stun, ...ISSUED])
    expect(await provide()).toEqual([stun, ...ISSUED])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(s.iceServers()).toEqual([stun, { urls: [CF_STUN] }])
  })

  it('carries the older combined answer to RelaySignaler.requestTurn without port 53', async () => {
    const { fetch } = mockFetch(() => json(COMBINED))
    const { r } = await cfRelay(fetch)
    const s = new RelaySignaler({ url: r.url, wallet: alice.wallet })
    try {
      const servers = await s.requestTurn()
      expect(servers[0]).toEqual(stun)
      expect(servers.flatMap(x => x.urls)).not.toContainEqual(expect.stringMatching(/:53\b/))
    } finally {
      await s.close()
    }
  })

  /**
   * Let Node report a promise nobody handled, which it does a turn after the rejection. Jest
   * then fails the run (`Test suite failed to run`, exit code 1), so a test that ends with
   * `settle()` cannot pass over an unhandled rejection the relay left behind.
   */
  const settle = (): Promise<void> => new Promise(res => setTimeout(res, 50))

  it('answers unavailable and leaves nothing unhandled when the log hook throws', async () => {
    const answers: Array<() => Response> = [
      () => new Response('down', { status: 503 }),
      () => json(CURRENT)
    ]
    const { fetch } = mockFetch(() => answers.shift()!())
    const { r } = await cfRelay(
      fetch,
      {},
      {
        log: line => {
          if (line.includes('could not get TURN credentials')) {
            throw new Error(`the log sink is down ${API_TOKEN}`)
          }
        }
      }
    )
    const a = await authed(r, alice)
    a.send({ t: 'turn' })
    // the reply slot is filled whatever the log hook does, so the client is not left waiting
    await waitFor(() => a.seen.length >= 4)
    expect(await a.next()).toEqual({ t: 'error', code: 'unavailable' })
    // and the replies behind it still flow
    expect((await requestTurn(a)).t).toBe('ice')
    await settle()
    expect(r.stats()).toEqual({ sockets: 1, identities: 1 })
  })

  it('closes a socket whose authentication fails unexpectedly, leaving nothing unhandled', async () => {
    const { fetch } = mockFetch(() => json(CURRENT))
    const { r } = await cfRelay(fetch)
    // the relay's reply to a good signature is what breaks: ws cannot write the `ready` frame
    const send = WebSocket.prototype.send
    const spy = jest.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      ...args: unknown[]
    ) {
      if (typeof args[0] === 'string' && args[0].includes('"t":"ready"')) {
        throw new Error('write failed')
      }
      return (send as (...a: unknown[]) => void).apply(this, args)
    })
    try {
      const c = rawAt(r.url)
      await authenticate(c, alice, r.url)
      // the relay cuts the socket off: it is gone from its books and closed at the client
      await waitFor(() => r.stats().sockets === 0)
      await c.closed
      await settle()
    } finally {
      spy.mockRestore()
    }
    // it carries on serving
    expect(r.stats()).toEqual({ sockets: 0, identities: 0 })
    const b = await authed(r, bob)
    expect((await requestTurn(b)).t).toBe('ice')
  })

  it('answers unavailable once its 5 s are up when Cloudflare never answers, and keeps the socket', async () => {
    const answers: Array<() => Promise<Response>> = [
      () => new Promise<Response>(() => {}),
      async () => json(CURRENT)
    ]
    const { fetch } = mockFetch(() => answers.shift()!())
    const { r, logs } = await cfRelay(fetch)
    const a = await authed(r, alice)
    // The real clock and event loop stay as they are for everything but the timers: the
    // sockets still deliver, and `pause` waits on the real clock.
    const realSetTimeout = setTimeout
    const pause = (ms: number): Promise<void> => new Promise(res => realSetTimeout(res, ms))
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    try {
      a.send({ t: 'turn' })
      while (fetch.mock.calls.length === 0) await pause(5)
      await jest.advanceTimersByTimeAsync(4999)
      await pause(100)
      // challenge, ready and ice only: the deadline has not passed
      expect(a.seen).toHaveLength(3)
      await jest.advanceTimersByTimeAsync(1)
      while (a.seen.length < 4) await pause(5)
    } finally {
      jest.useRealTimers()
    }
    expect(a.seen[3]).toEqual({ t: 'error', code: 'unavailable' })
    expect(logs.filter(line => line.includes('could not get TURN credentials'))).toEqual([
      'webrtpay relay: could not get TURN credentials from cloudflare: ' +
        'Cloudflare TURN: no answer within 5 s'
    ])
    // the socket stays open and is served again
    expect(a.ws.readyState).toBe(WebSocket.OPEN)
    expect(r.stats()).toEqual({ sockets: 1, identities: 1 })
    expect((await a.next()).t).toBe('error')
    expect((await requestTurn(a)).t).toBe('ice')
  })
})
