import { ArcSSEClient, ArcSSEClientOptions, ArcSSEEvent } from '../ArcSSEClient'

const TXID_A = 'aa'.repeat(32)
const TXID_B = 'bb'.repeat(32)
const TXID_C = 'cc'.repeat(32)
const TXID_D = 'dd'.repeat(32)

/** Minimal fake EventSource that records listener registrations and lets tests fire them */
class FakeEventSource {
  static instances: FakeEventSource[] = []

  url: string
  opts: any
  private listeners: Record<string, Array<(event: any) => void>> = {}
  closed = false

  constructor(url: string, opts: any) {
    this.url = url
    this.opts = opts
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: (event: any) => void): void {
    if (this.listeners[type] == null) this.listeners[type] = []
    this.listeners[type].push(fn)
  }

  /** Helper used by tests to simulate an incoming server event */
  emit(type: string, event: any = {}): void {
    for (const fn of this.listeners[type] ?? []) {
      fn(event)
    }
  }

  close(): void {
    this.closed = true
  }
}

function makeClient(overrides: Partial<ArcSSEClientOptions> = {}): {
  client: ArcSSEClient
  events: ArcSSEEvent[]
  errors: Error[]
  lastEventIds: string[]
} {
  FakeEventSource.instances = []
  const events: ArcSSEEvent[] = []
  const errors: Error[] = []
  const lastEventIds: string[] = []

  const client = new ArcSSEClient({
    baseUrl: 'https://arcade.example.com',
    callbackToken: 'tok-abc123',
    onEvent: e => events.push(e),
    onError: e => errors.push(e),
    onLastEventIdChanged: id => lastEventIds.push(id),
    EventSourceClass: FakeEventSource,
    ...overrides
  })

  return { client, events, errors, lastEventIds }
}

describe('ArcSSEClient', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  // ── URL construction ──────────────────────────────────────────────────────

  describe('URL construction', () => {
    test('builds correct URL with no trailing slash', () => {
      const { client } = makeClient({ baseUrl: 'https://arcade.example.com' })
      client.connect()
      const es = FakeEventSource.instances[0]
      expect(es.url).toBe('https://arcade.example.com/events?callbackToken=tok-abc123')
    })

    test('strips single trailing slash from baseUrl', () => {
      const { client } = makeClient({ baseUrl: 'https://arcade.example.com/' })
      client.connect()
      expect(FakeEventSource.instances[0].url).toBe('https://arcade.example.com/events?callbackToken=tok-abc123')
    })

    test('strips multiple trailing slashes from baseUrl', () => {
      const { client } = makeClient({ baseUrl: 'https://arcade.example.com///' })
      client.connect()
      expect(FakeEventSource.instances[0].url).toBe('https://arcade.example.com/events?callbackToken=tok-abc123')
    })

    test('percent-encodes callbackToken in URL', () => {
      const { client } = makeClient({ callbackToken: 'tok with spaces & chars' })
      client.connect()
      expect(FakeEventSource.instances[0].url).toContain('callbackToken=tok%20with%20spaces%20%26%20chars')
    })

    test('requires HTTPS except for explicit loopback development', () => {
      expect(() => makeClient({ baseUrl: 'http://arcade.example.com' })).toThrow('requires HTTPS')
      expect(() => makeClient({ baseUrl: 'http://localhost:8080' })).not.toThrow()
      expect(() => makeClient({ baseUrl: 'http://127.0.0.1:8080' })).not.toThrow()
      expect(() => makeClient({ baseUrl: 'http://[::1]:8080' })).not.toThrow()
      expect(() => makeClient({ baseUrl: 'http://wallet.localhost:8080' })).not.toThrow()
    })

    test('rejects non-plain options and malformed callback surfaces', () => {
      expect(() => new ArcSSEClient(null as never)).toThrow('plain data object')
      expect(() => new ArcSSEClient([] as never)).toThrow('plain data object')
      const inherited = Object.assign(Object.create({ inherited: true }), {
        baseUrl: 'https://arcade.example.com',
        callbackToken: 'token',
        onEvent: () => {},
        EventSourceClass: FakeEventSource
      })
      expect(() => new ArcSSEClient(inherited)).toThrow('plain data object')
      expect(() => makeClient({ onEvent: null as never })).toThrow('onEvent')
      expect(() => makeClient({ onError: 1 as never })).toThrow('onError')
      expect(() => makeClient({ onLastEventIdChanged: 'callback' as never })).toThrow('onLastEventIdChanged')
      expect(() => makeClient({ log: {} as never })).toThrow('log')
      expect(() => makeClient({ EventSourceClass: {} })).toThrow('EventSourceClass')
    })

    test('rejects empty, relative, control-bearing, and overlong base URLs', () => {
      for (const baseUrl of ['', '/events', 'https://arcade.example.com\nforged', `https://${'a'.repeat(2050)}.com`]) {
        expect(() => makeClient({ baseUrl })).toThrow(/base URL|absolute/)
      }
    })

    test('rejects credentials, query parameters, and fragments in the base URL', () => {
      expect(() => makeClient({ baseUrl: 'https://user:pass@arcade.example.com' })).toThrow(
        'cannot include credentials'
      )
      expect(() => makeClient({ baseUrl: 'https://arcade.example.com?token=secret' })).toThrow(
        'cannot include credentials'
      )
      expect(() => makeClient({ baseUrl: 'https://arcade.example.com#events' })).toThrow('cannot include credentials')
    })

    test('snapshots validated credentials and cursors without invoking accessors', () => {
      const options: ArcSSEClientOptions = {
        baseUrl: 'https://arcade.example.com',
        callbackToken: 'original-token',
        arcApiKey: 'original-key',
        lastEventId: 'original-cursor',
        onEvent: () => {},
        EventSourceClass: FakeEventSource
      }
      const client = new ArcSSEClient(options)
      options.callbackToken = 'mutated-token'
      options.arcApiKey = 'mutated-key'
      options.lastEventId = 'mutated-cursor'
      client.connect()

      expect(FakeEventSource.instances[0].url).toContain('original-token')
      expect(FakeEventSource.instances[0].opts.headers.Authorization).toBe('Bearer original-key')
      expect(FakeEventSource.instances[0].opts.headers['Last-Event-ID']).toBe('original-cursor')

      const accessorOptions = {
        baseUrl: 'https://arcade.example.com',
        onEvent: () => {},
        EventSourceClass: FakeEventSource
      } as ArcSSEClientOptions
      Object.defineProperty(accessorOptions, 'callbackToken', { get: () => 'hidden-token', enumerable: true })
      expect(() => new ArcSSEClient(accessorOptions)).toThrow('data property')
    })

    test('rejects control-bearing credentials and unsafe resource limits', () => {
      expect(() => makeClient({ callbackToken: 'token\nforged' })).toThrow('control-free')
      expect(() => makeClient({ arcApiKey: 'key\rforged' })).toThrow('control-free')
      expect(() => makeClient({ lastEventId: 'cursor\nforged' })).toThrow('control-free')
      expect(() => makeClient({ maxEventBytes: 0 })).toThrow('maxEventBytes')
      expect(() => makeClient({ maxPendingEvents: 5000 })).toThrow('maxPendingEvents')
      expect(() => makeClient({ maxPendingBytes: 100_000_000 })).toThrow('maxPendingBytes')
    })
  })

  // ── connect ───────────────────────────────────────────────────────────────

  describe('connect()', () => {
    test('creates an EventSource with correct headers', () => {
      const { client } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      expect(es.opts.headers['Last-Event-ID']).toBe('0')
      expect(es.opts.debug).toBe(false)
    })

    test('uses lastEventId from options as Last-Event-ID header', () => {
      const { client } = makeClient({ lastEventId: '42' })
      client.connect()
      expect(FakeEventSource.instances[0].opts.headers['Last-Event-ID']).toBe('42')
    })

    test('does not create a second EventSource when already connected', () => {
      const { client } = makeClient()
      client.connect()
      client.connect()
      expect(FakeEventSource.instances).toHaveLength(1)
    })

    test('is silent by default and never logs the callback token', () => {
      const logSpy = jest.spyOn(console, 'log')
      const { client } = makeClient()
      client.connect()
      const logged = logSpy.mock.calls.map(call => call.join(' ')).join('\n')
      expect(logged).toBe('')
      expect(logged).not.toContain('tok-abc123')
    })

    test('open event sets connected state (no crash)', () => {
      const { client } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      expect(() => es.emit('open')).not.toThrow()
    })

    test('contains malformed EventSource instances and hostile close methods', () => {
      class InvalidEventSource {}
      const invalid = makeClient({ EventSourceClass: InvalidEventSource })
      expect(() => invalid.client.connect()).toThrow('Unable to initialize')

      class HostileEventSource {
        close(): void {
          throw new Error('hostile close')
        }
      }
      const hostile = makeClient({ EventSourceClass: HostileEventSource })
      expect(() => hostile.client.connect()).toThrow('Unable to initialize')
      expect(() => hostile.client.connect()).toThrow('Unable to initialize')
    })
  })

  // ── status event handling ─────────────────────────────────────────────────

  describe('status events', () => {
    test('dispatches parsed event to onEvent callback', () => {
      const { client, events } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      const payload: ArcSSEEvent = { txid: TXID_A, txStatus: 'MINED', timestamp: '2025-01-01T00:00:00Z' }
      es.emit('status', { data: JSON.stringify(payload) })
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual(payload)
    })

    test('updates lastEventId only after processing and persistence complete', async () => {
      const { client, lastEventIds } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', {
        data: JSON.stringify({ txid: TXID_B, txStatus: 'SEEN_ON_NETWORK', timestamp: '' }),
        lastEventId: '99'
      })
      expect(client.lastEventId).toBeUndefined()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(client.lastEventId).toBe('99')
      expect(lastEventIds).toEqual(['99'])
    })

    test('does not advance lastEventId when durable event processing fails', async () => {
      const processingError = new Error('storage unavailable')
      const { client, errors, lastEventIds } = makeClient({
        onEvent: async () => await Promise.reject(processingError)
      })
      client.connect()
      FakeEventSource.instances[0].emit('status', {
        data: JSON.stringify({ txid: TXID_B, txStatus: 'REJECTED', timestamp: '' }),
        lastEventId: '100'
      })
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(client.lastEventId).toBeUndefined()
      expect(lastEventIds).toEqual([])
      expect(errors).toEqual([processingError])
    })

    test('reports a synchronous processing failure without acknowledging the event', () => {
      const { client, errors, lastEventIds } = makeClient({
        onEvent: () => {
          throw new Error('synchronous storage failure')
        }
      })
      client.connect()

      expect(() =>
        FakeEventSource.instances[0].emit('status', {
          data: JSON.stringify({ txid: TXID_B, txStatus: 'REJECTED', timestamp: '' }),
          lastEventId: '101'
        })
      ).not.toThrow()

      expect(client.lastEventId).toBeUndefined()
      expect(lastEventIds).toEqual([])
      expect(errors.map(error => error.message)).toEqual(['synchronous storage failure'])
    })

    test('does not update lastEventId when event has no lastEventId', () => {
      const { client } = makeClient({ lastEventId: 'initial' })
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', {
        data: JSON.stringify({ txid: TXID_C, txStatus: 'MINED', timestamp: '' })
        // no lastEventId field
      })
      expect(client.lastEventId).toBe('initial')
    })

    test('fails the stream closed on malformed event JSON', () => {
      const { client, events, errors } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      expect(() => es.emit('status', { data: 'not-json' })).not.toThrow()
      expect(events).toHaveLength(0)
      expect(errors[0].message).toBe('Arcade SSE supplied an invalid or excessive status event.')
      expect(es.closed).toBe(true)
    })

    test('serializes event processing and cursor commits in exact arrival order', async () => {
      let releaseFirst!: () => void
      const firstPending = new Promise<void>(resolve => {
        releaseFirst = resolve
      })
      const order: string[] = []
      const { client, lastEventIds } = makeClient({
        onEvent: async event => {
          order.push(`start:${event.txid}`)
          if (event.txid === TXID_A) await firstPending
          order.push(`end:${event.txid}`)
        }
      })
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', {
        data: JSON.stringify({ txid: TXID_A, txStatus: 'MINED', timestamp: '' }),
        lastEventId: '1'
      })
      es.emit('status', {
        data: JSON.stringify({ txid: TXID_B, txStatus: 'MINED', timestamp: '' }),
        lastEventId: '2'
      })

      expect(order).toEqual([`start:${TXID_A}`])
      expect(client.lastEventId).toBeUndefined()
      releaseFirst()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(order).toEqual([`start:${TXID_A}`, `end:${TXID_A}`, `start:${TXID_B}`, `end:${TXID_B}`])
      expect(lastEventIds).toEqual(['1', '2'])
      expect(client.lastEventId).toBe('2')
    })

    test('does not dispatch or checkpoint later queued events after an earlier failure', async () => {
      let rejectFirst!: (error: Error) => void
      const firstPending = new Promise<void>((_resolve, reject) => {
        rejectFirst = reject
      })
      const seen: string[] = []
      const failure = new Error('durable write failed')
      const { client, errors, lastEventIds } = makeClient({
        onEvent: async event => {
          seen.push(event.txid)
          if (event.txid === TXID_A) await firstPending
        }
      })
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', {
        data: JSON.stringify({ txid: TXID_A, txStatus: 'MINED', timestamp: '' }),
        lastEventId: '1'
      })
      es.emit('status', {
        data: JSON.stringify({ txid: TXID_B, txStatus: 'MINED', timestamp: '' }),
        lastEventId: '2'
      })
      rejectFirst(failure)
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(seen).toEqual([TXID_A])
      expect(lastEventIds).toEqual([])
      expect(client.lastEventId).toBeUndefined()
      expect(errors).toEqual([failure])
      expect(es.closed).toBe(true)
    })

    test('enforces aggregate pending-event capacity while durable work is blocked', async () => {
      let release!: () => void
      const pending = new Promise<void>(resolve => {
        release = resolve
      })
      const { client, errors } = makeClient({
        maxPendingEvents: 1,
        onEvent: async () => await pending
      })
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', { data: JSON.stringify({ txid: TXID_A, txStatus: 'MINED', timestamp: '' }) })
      es.emit('status', { data: JSON.stringify({ txid: TXID_B, txStatus: 'MINED', timestamp: '' }) })

      expect(es.closed).toBe(true)
      expect(errors[0].message).toBe('Arcade SSE supplied an invalid or excessive status event.')
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    test('rejects oversized and noncanonical event fields without retaining their content', () => {
      const { client, events, errors } = makeClient({ maxEventBytes: 128 })
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', {
        data: JSON.stringify({ txid: TXID_A, txStatus: 'MINED', timestamp: '', extra: 'x'.repeat(500) })
      })
      expect(events).toEqual([])
      expect(errors[0].message).not.toContain('x'.repeat(20))
      expect(es.closed).toBe(true)
    })

    test('normalizes all optional event fields and lowercases cryptographic identifiers', () => {
      const { client, events } = makeClient()
      client.connect()
      FakeEventSource.instances[0].emit('status', {
        data: JSON.stringify({
          txid: TXID_A.toUpperCase(),
          txStatus: 'REJECTED',
          timestamp: '',
          status: 465,
          extraInfo: 'script rejected',
          blockHash: TXID_B.toUpperCase(),
          blockHeight: 0,
          merklePath: ''
        }),
        lastEventId: 'cursor-1'
      })
      expect(events).toEqual([
        {
          txid: TXID_A,
          txStatus: 'REJECTED',
          timestamp: '',
          eventId: 'cursor-1',
          status: 465,
          extraInfo: 'script rejected',
          blockHash: TXID_B,
          blockHeight: 0,
          merklePath: ''
        }
      ])
    })

    test.each([
      ['txid', { txid: 'bad', txStatus: 'MINED', timestamp: '' }],
      ['status token', { txid: TXID_A, txStatus: 'mined', timestamp: '' }],
      ['status code', { txid: TXID_A, txStatus: 'REJECTED', timestamp: '', status: -1 }],
      ['block hash', { txid: TXID_A, txStatus: 'MINED', timestamp: '', blockHash: 'bad' }],
      ['block height', { txid: TXID_A, txStatus: 'MINED', timestamp: '', blockHeight: 0x100000000 }]
    ])('fails the stream closed for an invalid %s', (_name, payload) => {
      const { client, errors } = makeClient()
      client.connect()
      FakeEventSource.instances[0].emit('status', { data: JSON.stringify(payload) })
      expect(errors).toHaveLength(1)
      expect(FakeEventSource.instances[0].closed).toBe(true)
    })

    test('does not invoke accessor-backed event data and enforces UTF-8 byte limits', () => {
      const getter = jest.fn(() => JSON.stringify({ txid: TXID_A, txStatus: 'MINED', timestamp: '' }))
      const first = makeClient()
      first.client.connect()
      const event = {}
      Object.defineProperty(event, 'data', { enumerable: true, get: getter })
      FakeEventSource.instances[0].emit('status', event)
      expect(getter).not.toHaveBeenCalled()
      expect(first.errors).toHaveLength(1)

      const raw = JSON.stringify({ txid: TXID_A, txStatus: 'MINED', timestamp: 'é'.repeat(20) })
      const second = makeClient({ maxEventBytes: raw.length })
      second.client.connect()
      FakeEventSource.instances[0].emit('status', { data: raw })
      expect(second.events).toEqual([])
      expect(second.errors).toHaveLength(1)
    })

    test('enforces aggregate pending-byte capacity independently of event count', async () => {
      let release!: () => void
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      const raw = JSON.stringify({ txid: TXID_A, txStatus: 'MINED', timestamp: '' })
      const { client, errors } = makeClient({
        maxPendingEvents: 10,
        maxPendingBytes: new TextEncoder().encode(raw).length,
        onEvent: async () => await blocked
      })
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', { data: raw })
      es.emit('status', { data: raw })
      expect(errors).toHaveLength(1)
      expect(es.closed).toBe(true)
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  })

  // ── error event handling ──────────────────────────────────────────────────

  describe('error events', () => {
    test('reports a generic error without forwarding credential-bearing event fields', () => {
      const { client, errors } = makeClient()
      client.connect()
      const logSpy = jest.spyOn(console, 'log')
      FakeEventSource.instances[0].emit('error', {
        message: 'connection refused',
        url: 'https://arcade.example.com/events?callbackToken=tok-abc123',
        headers: { Authorization: 'Bearer arc-secret' }
      })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe('Arcade SSE connection error.')
      const logged = logSpy.mock.calls.map(call => call.join(' ')).join('\n')
      expect(logged).toBe('')
      expect(logged).not.toContain('tok-abc123')
      expect(logged).not.toContain('arc-secret')
    })

    test('calls onError with generic message when event has no message', () => {
      const { client, errors } = makeClient()
      client.connect()
      FakeEventSource.instances[0].emit('error', {})
      expect(errors[0].message).toBe('Arcade SSE connection error.')
    })

    test('does not throw when onError is not provided', () => {
      const client = new ArcSSEClient({
        baseUrl: 'https://arcade.example.com',
        callbackToken: 'tok',
        onEvent: () => {},
        EventSourceClass: FakeEventSource
      })
      client.connect()
      expect(() => FakeEventSource.instances[0].emit('error', {})).not.toThrow()
    })

    test('contains synchronous and asynchronous onError callback failures', async () => {
      const sync = makeClient({
        onError: () => {
          throw new Error('host callback failed')
        }
      })
      sync.client.connect()
      expect(() => FakeEventSource.instances[0].emit('error', {})).not.toThrow()

      const asyncFailure = makeClient({ onError: async () => await Promise.reject(new Error('async callback failed')) })
      asyncFailure.client.connect()
      expect(() => FakeEventSource.instances[0].emit('error', {})).not.toThrow()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  })

  // ── close ─────────────────────────────────────────────────────────────────

  describe('close()', () => {
    test('calls close on the underlying EventSource', () => {
      const { client } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      client.close()
      expect(es.closed).toBe(true)
    })

    test('is a no-op when not connected', () => {
      const { client } = makeClient()
      expect(() => client.close()).not.toThrow()
    })

    test('allows reconnect after close', () => {
      const { client } = makeClient()
      client.connect()
      client.close()
      client.connect()
      expect(FakeEventSource.instances).toHaveLength(2)
    })
  })

  // ── fetchEvents ───────────────────────────────────────────────────────────

  describe('fetchEvents()', () => {
    test('returns 0', async () => {
      const { client } = makeClient()
      const result = await client.fetchEvents()
      expect(result).toBe(0)
    })

    test('opens connection if not already connected', async () => {
      const { client } = makeClient()
      await client.fetchEvents()
      expect(FakeEventSource.instances).toHaveLength(1)
    })

    test('does not open a second connection when already connected', async () => {
      const { client } = makeClient()
      client.connect()
      FakeEventSource.instances[0].emit('open') // mark as connected
      await client.fetchEvents()
      expect(FakeEventSource.instances).toHaveLength(1)
    })

    test('does not reconnect while connecting (open not yet fired)', async () => {
      const { client } = makeClient()
      client.connect()
      // es exists, connected=false but connecting=true (open never fired yet)
      await client.fetchEvents()
      // should NOT tear down — still in connecting state
      expect(FakeEventSource.instances[0].closed).toBeFalsy()
      expect(FakeEventSource.instances).toHaveLength(1)
    })

    test('reconnects with stale (errored) EventSource by closing first', async () => {
      const { client } = makeClient()
      client.connect()
      // Simulate error which clears connecting flag
      FakeEventSource.instances[0].emit('error', { message: 'fail' })
      // Now es exists, connected=false, connecting=false — should reconnect
      await client.fetchEvents()
      expect(FakeEventSource.instances[0].closed).toBe(true)
      expect(FakeEventSource.instances).toHaveLength(2)
    })
  })

  // ── lastEventId getter ────────────────────────────────────────────────────

  describe('lastEventId', () => {
    test('returns undefined when not set', () => {
      const { client } = makeClient()
      expect(client.lastEventId).toBeUndefined()
    })

    test('returns initial value from options', () => {
      const { client } = makeClient({ lastEventId: 'start' })
      expect(client.lastEventId).toBe('start')
    })

    test('advances as events are durably processed', async () => {
      const { client } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', {
        data: JSON.stringify({ txid: TXID_C, txStatus: 'MINED', timestamp: '' }),
        lastEventId: '1'
      })
      es.emit('status', {
        data: JSON.stringify({ txid: TXID_D, txStatus: 'MINED', timestamp: '' }),
        lastEventId: '2'
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(client.lastEventId).toBe('2')
    })
  })
})
