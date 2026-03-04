import { ArcSSEClient, ArcSSEClientOptions, ArcSSEEvent } from '../ArcSSEClient'

/** Minimal fake EventSource that records listener registrations and lets tests fire them */
class FakeEventSource {
  static instances: FakeEventSource[] = []

  url: string
  opts: any
  private listeners: Record<string, ((event: any) => void)[]> = {}
  closed = false

  constructor(url: string, opts: any) {
    this.url = url
    this.opts = opts
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: (event: any) => void): void {
    if (!this.listeners[type]) this.listeners[type] = []
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
  })

  // ── connect ───────────────────────────────────────────────────────────────

  describe('connect()', () => {
    test('creates an EventSource with correct headers', () => {
      const { client } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      expect(es.opts.headers['Last-Event-ID']).toBe('0')
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
      expect(FakeEventSource.instances.length).toBe(1)
    })

    test('open event sets connected state (no crash)', () => {
      const { client } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      expect(() => es.emit('open')).not.toThrow()
    })
  })

  // ── status event handling ─────────────────────────────────────────────────

  describe('status events', () => {
    test('dispatches parsed event to onEvent callback', () => {
      const { client, events } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      const payload: ArcSSEEvent = { txid: 'aaaa', txStatus: 'MINED', timestamp: '2025-01-01T00:00:00Z' }
      es.emit('status', { data: JSON.stringify(payload) })
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual(payload)
    })

    test('updates lastEventId and calls onLastEventIdChanged', () => {
      const { client, lastEventIds } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', {
        data: JSON.stringify({ txid: 'bbbb', txStatus: 'SEEN_ON_NETWORK', timestamp: '' }),
        lastEventId: '99'
      })
      expect(client.lastEventId).toBe('99')
      expect(lastEventIds).toEqual(['99'])
    })

    test('does not update lastEventId when event has no lastEventId', () => {
      const { client } = makeClient({ lastEventId: 'initial' })
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', {
        data: JSON.stringify({ txid: 'cccc', txStatus: 'MINED', timestamp: '' })
        // no lastEventId field
      })
      expect(client.lastEventId).toBe('initial')
    })

    test('ignores malformed JSON without throwing', () => {
      const { client, events } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      expect(() => es.emit('status', { data: 'not-json' })).not.toThrow()
      expect(events).toHaveLength(0)
    })
  })

  // ── error event handling ──────────────────────────────────────────────────

  describe('error events', () => {
    test('calls onError with message from event', () => {
      const { client, errors } = makeClient()
      client.connect()
      FakeEventSource.instances[0].emit('error', { message: 'connection refused' })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe('connection refused')
    })

    test('calls onError with generic message when event has no message', () => {
      const { client, errors } = makeClient()
      client.connect()
      FakeEventSource.instances[0].emit('error', {})
      expect(errors[0].message).toBe('SSE error')
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
      expect(FakeEventSource.instances.length).toBe(2)
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
      expect(FakeEventSource.instances.length).toBe(1)
    })

    test('does not open a second connection when already connected', async () => {
      const { client } = makeClient()
      client.connect()
      FakeEventSource.instances[0].emit('open') // mark as connected
      await client.fetchEvents()
      expect(FakeEventSource.instances.length).toBe(1)
    })

    test('reconnects with stale (non-open) EventSource by closing first', async () => {
      const { client } = makeClient()
      client.connect()
      // es exists but connected=false (open never fired)
      await client.fetchEvents()
      // stale es should be closed, new one opened
      expect(FakeEventSource.instances[0].closed).toBe(true)
      expect(FakeEventSource.instances.length).toBe(2)
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

    test('advances as events are received', () => {
      const { client } = makeClient()
      client.connect()
      const es = FakeEventSource.instances[0]
      es.emit('status', {
        data: JSON.stringify({ txid: 'x', txStatus: 'MINED', timestamp: '' }),
        lastEventId: '1'
      })
      es.emit('status', {
        data: JSON.stringify({ txid: 'y', txStatus: 'MINED', timestamp: '' }),
        lastEventId: '2'
      })
      expect(client.lastEventId).toBe('2')
    })
  })
})
