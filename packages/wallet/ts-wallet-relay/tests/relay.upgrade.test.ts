/**
 * Upgrade-routing tests for WebSocketRelay: coexistence with other WS services
 * on the same HTTP server, noServer mode, custom path, and listener cleanup.
 */
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { WebSocketRelay } from '../src/server/WebSocketRelay.js'

function startListening(server: http.Server): Promise<number> {
  return new Promise(resolve =>
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  )
}
function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
}
/** Resolve 'open' | 'error' | 'timeout' for a client connecting to `url`. */
function connectOutcome(url: string, ms = 1500): Promise<'open' | 'error' | 'timeout'> {
  return new Promise(resolve => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.terminate()
      resolve('timeout')
    }, ms)
    ws.on('open', () => {
      clearTimeout(timer)
      ws.close()
      resolve('open')
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve('error')
    })
  })
}

describe('WebSocketRelay upgrade routing', () => {
  let server: http.Server
  let port: number

  beforeEach(async () => {
    server = http.createServer()
    port = await startListening(server)
  })
  afterEach(async () => {
    await stopServer(server)
  })

  it('coexists with another WS service on a different path (the reported bug)', async () => {
    const relay = new WebSocketRelay(server)
    const msgWss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '', 'http://localhost')
      if (pathname === '/ws/messaging') {
        msgWss.handleUpgrade(req, socket, head, ws => msgWss.emit('connection', ws, req))
      }
    })
    try {
      expect(await connectOutcome(`ws://localhost:${port}/ws/messaging`)).toBe('open')
      expect(await connectOutcome(`ws://localhost:${port}/ws?topic=t&role=mobile`)).toBe('open')
    } finally {
      relay.close()
      msgWss.close()
    }
  })

  it('noServer mode attaches no upgrade listener and works via handleUpgrade', async () => {
    const before = server.listenerCount('upgrade')
    const relay = new WebSocketRelay(server, { noServer: true })
    expect(server.listenerCount('upgrade')).toBe(before)
    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '', 'http://localhost')
      if (pathname === '/ws') relay.handleUpgrade(req, socket, head)
    })
    try {
      expect(await connectOutcome(`ws://localhost:${port}/ws?topic=t&role=mobile`)).toBe('open')
    } finally {
      relay.close()
    }
  })

  it('honors a custom path and ignores others', async () => {
    const relay = new WebSocketRelay(server, { path: '/wallet-ws' })
    // Node hands an upgraded socket off entirely (allowHalfOpen: true, and it
    // leaves the server's own connection tracking) — nobody but this test
    // owns it once the relay ignores it, so we must destroy it ourselves
    // after the assertion below, or server.close() in afterEach hangs forever.
    const orphans: import('node:stream').Duplex[] = []
    server.on('upgrade', (req, socket) => {
      const { pathname } = new URL(req.url ?? '', 'http://localhost')
      if (pathname !== '/wallet-ws') orphans.push(socket)
    })
    try {
      expect(await connectOutcome(`ws://localhost:${port}/wallet-ws?topic=t&role=mobile`)).toBe(
        'open'
      )
      // Nothing claims '/ws' → the socket hangs unanswered → client never opens.
      expect(await connectOutcome(`ws://localhost:${port}/ws?topic=t&role=mobile`, 500)).toBe(
        'timeout'
      )
    } finally {
      relay.close()
      for (const socket of orphans) socket.destroy()
    }
  })

  it('removes its upgrade listener on close()', () => {
    const before = server.listenerCount('upgrade')
    const relay = new WebSocketRelay(server)
    expect(server.listenerCount('upgrade')).toBe(before + 1)
    relay.close()
    expect(server.listenerCount('upgrade')).toBe(before)
  })
})
