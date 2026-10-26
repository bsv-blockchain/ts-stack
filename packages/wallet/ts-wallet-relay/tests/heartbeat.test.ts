/**
 * Heartbeat tolerance and close reporting for WebSocketRelay.
 *
 * Uses a real HTTP server and real `ws` clients with a very short heartbeat interval,
 * rather than fake timers: ping and pong are I/O, and faking the clock while the
 * frames travel over a loopback socket makes the ordering meaningless.
 */

import http from 'node:http'
import { WebSocket } from 'ws'
import { WebSocketRelay } from '../src/server/WebSocketRelay.js'
import type { SocketCloseInfo } from '../src/server/WebSocketRelay.js'

const INTERVAL_MS = 60

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve =>
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  )
}

function stop(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve =>
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  )
}

/** Wait for the server-side close event, which lands a few ms after the client's. */
const SETTLE_MS = 30

describe('WebSocketRelay heartbeat', () => {
  let server: http.Server | null = null
  let relay: WebSocketRelay | null = null
  let url: string
  let closes: SocketCloseInfo[]
  let clients: WebSocket[] = []

  async function start(maxMissedHeartbeats?: number) {
    server = http.createServer()
    relay = new WebSocketRelay(server, {
      heartbeatIntervalMs: INTERVAL_MS,
      ...(maxMissedHeartbeats !== undefined ? { maxMissedHeartbeats } : {})
    })
    // Bind this relay to its own array. Server-side close events from a previous test's
    // terminated sockets can land after the next test has started, and must not leak in.
    const own: SocketCloseInfo[] = []
    closes = own
    relay.onSocketClose(info => own.push(info))
    const port = await listen(server)
    url = `ws://localhost:${port}/ws`
  }

  afterEach(async () => {
    for (const c of clients) c.terminate()
    clients = []
    relay?.close()
    relay = null
    if (server) await stop(server)
    server = null
  })

  function connect(role: 'mobile' | 'desktop', topic = 't1', autoPong = true): WebSocket {
    const ws = new WebSocket(`${url}?topic=${topic}&role=${role}`, { autoPong })
    clients.push(ws)
    return ws
  }

  it('terminates a socket that never answers pings only after the tolerated misses', async () => {
    await start() // default: 2 missed pongs
    const ws = connect('mobile', 't1', false)
    await opened(ws)
    const done = closed(ws)

    // One interval in: pinged once, one miss recorded, must still be open.
    await sleep(INTERVAL_MS * 1.5)
    expect(ws.readyState).toBe(WebSocket.OPEN)

    // Terminated on the tick after the second miss, so within three intervals.
    const result = await Promise.race([done, sleep(INTERVAL_MS * 4).then(() => null)])
    expect(result).not.toBeNull()
    expect(result!.code).toBe(1006)
    await sleep(SETTLE_MS)
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({
      topic: 't1',
      role: 'mobile',
      cause: 'heartbeat',
      missedPongs: 2
    })
    expect(closes[0].connectedForMs).toBeGreaterThanOrEqual(INTERVAL_MS * 2)
  })

  it('does not terminate a socket that misses one pong and then answers', async () => {
    await start()
    const ws = connect('mobile', 't1', false)
    let pings = 0
    ws.on('ping', data => {
      pings += 1
      if (pings >= 2) ws.pong(data) // swallow the first ping, answer everything after
    })
    await opened(ws)
    await sleep(INTERVAL_MS * 6)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(pings).toBeGreaterThanOrEqual(4)
    expect(closes).toHaveLength(0)
    ws.close()
  })

  it('treats an inbound message as proof of life even when pongs never arrive', async () => {
    await start()
    const ws = connect('mobile', 't1', false)
    await opened(ws)
    const keepalive = setInterval(
      () => ws.send(JSON.stringify({ type: 'keepalive' })),
      INTERVAL_MS / 2
    )
    await sleep(INTERVAL_MS * 6)
    clearInterval(keepalive)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(closes).toHaveLength(0)
    ws.close()
  })

  it('maxMissedHeartbeats: 1 restores terminate-on-first-miss', async () => {
    await start(1)
    const ws = connect('mobile', 't1', false)
    await opened(ws)
    const result = await Promise.race([closed(ws), sleep(INTERVAL_MS * 3).then(() => null)])
    expect(result).not.toBeNull()
    await sleep(SETTLE_MS)
    expect(closes[0]).toMatchObject({ cause: 'heartbeat', missedPongs: 1 })
  })

  it('rejects an invalid tolerance', () => {
    const s = http.createServer()
    expect(() => new WebSocketRelay(s, { maxMissedHeartbeats: 0 })).toThrow(RangeError)
    expect(() => new WebSocketRelay(s, { maxMissedHeartbeats: 1.5 })).toThrow(RangeError)
  })

  // A non-finite interval is not inert: Node coerces both NaN and Infinity to a 1 ms
  // delay, which would ping every socket a thousand times a second.
  it('rejects an invalid heartbeat interval', () => {
    const s = http.createServer()
    expect(() => new WebSocketRelay(s, { heartbeatIntervalMs: 0 })).toThrow(RangeError)
    expect(() => new WebSocketRelay(s, { heartbeatIntervalMs: -1 })).toThrow(RangeError)
    expect(() => new WebSocketRelay(s, { heartbeatIntervalMs: NaN })).toThrow(RangeError)
    expect(() => new WebSocketRelay(s, { heartbeatIntervalMs: Infinity })).toThrow(RangeError)
    expect(() => new WebSocketRelay(s, { heartbeatIntervalMs: 1.5 })).toThrow(RangeError)
    expect(() => new WebSocketRelay(s, { heartbeatIntervalMs: 2_147_483_648 })).toThrow(RangeError)
  })
})

describe('WebSocketRelay close reporting', () => {
  let server: http.Server
  let relay: WebSocketRelay
  let url: string
  let closes: SocketCloseInfo[]
  let disconnects: Array<{ topic: string; role: string; info: SocketCloseInfo }>

  beforeEach(async () => {
    server = http.createServer()
    relay = new WebSocketRelay(server, { heartbeatIntervalMs: 10_000 })
    const ownCloses: SocketCloseInfo[] = []
    const ownDisconnects: typeof disconnects = []
    closes = ownCloses
    disconnects = ownDisconnects
    relay.onSocketClose(info => ownCloses.push(info))
    relay.onDisconnect((topic, role, info) => ownDisconnects.push({ topic, role, info }))
    const port = await listen(server)
    url = `ws://localhost:${port}/ws`
  })

  let clients: WebSocket[] = []

  afterEach(async () => {
    for (const c of clients) c.terminate()
    clients = []
    relay.close()
    await stop(server)
  })

  function connect(role: 'mobile' | 'desktop', topic = 't1'): WebSocket {
    const ws = new WebSocket(`${url}?topic=${topic}&role=${role}`)
    clients.push(ws)
    return ws
  }

  it('reports a clean client close with its code and reason', async () => {
    const ws = connect('mobile')
    await opened(ws)
    const done = closed(ws)
    ws.close(1000, 'bye')
    await done
    await sleep(20)
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({
      topic: 't1',
      role: 'mobile',
      code: 1000,
      reason: 'bye',
      cause: 'client',
      missedPongs: 0
    })
    expect(disconnects).toHaveLength(1)
    expect(disconnects[0].info).toBe(closes[0])
  })

  it.each(['throw', 'reject'])(
    'contains a diagnostic callback that will %s and preserves reconnects',
    async failure => {
      const reported: SocketCloseInfo[] = []
      relay.onSocketClose(info => {
        reported.push(info)
        if (failure === 'throw') throw new Error('diagnostic unavailable')
        return Promise.reject(new Error('diagnostic unavailable'))
      })
      const ws = connect('mobile')
      await opened(ws)
      const done = closed(ws)
      ws.close(1000)
      await done
      await sleep(SETTLE_MS)
      expect(reported).toHaveLength(1)
      expect(disconnects).toHaveLength(1)
      expect(disconnects[0].info).toBe(reported[0])

      const replacement = connect('mobile')
      await opened(replacement)
      const replacementClosed = closed(replacement)
      replacement.close(1000)
      await replacementClosed
      await sleep(SETTLE_MS)
      expect(reported).toHaveLength(2)
      expect(disconnects).toHaveLength(2)
    }
  )

  it('reports a server-initiated close from disconnectMobile', async () => {
    const ws = connect('mobile')
    await opened(ws)
    const done = closed(ws)
    relay.disconnectMobile('t1')
    const result = await done
    await sleep(20)
    expect(result.code).toBe(1008)
    expect(closes[0]).toMatchObject({
      cause: 'server',
      code: 1008,
      reason: 'Authentication failed'
    })
    // disconnectMobile clears the slot itself, so onDisconnect must not fire a second time.
    expect(disconnects).toHaveLength(0)
  })

  it('rejects mobile replacement and reports disconnects for both active roles', async () => {
    const desktop = connect('desktop')
    const mobileA = connect('mobile')
    await Promise.all([opened(desktop), opened(mobileA)])
    const mobileB = connect('mobile')
    const bClosed = closed(mobileB)
    await opened(mobileB)
    await expect(bClosed).resolves.toMatchObject({
      code: 1008,
      reason: 'A mobile connection is already active'
    })

    const aClosed = closed(mobileA)
    mobileA.close(1000)
    await aClosed
    const dClosed = closed(desktop)
    desktop.close(1001)
    await dClosed
    await sleep(20)

    expect(closes.map(c => [c.role, c.code])).toEqual([
      ['mobile', 1000],
      ['desktop', 1001]
    ])
    expect(disconnects.map(d => d.role)).toEqual(['mobile', 'desktop'])
  })
})
