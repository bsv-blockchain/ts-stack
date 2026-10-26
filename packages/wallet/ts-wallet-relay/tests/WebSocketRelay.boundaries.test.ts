import http from 'node:http'
import { WebSocket } from 'ws'
import { DESKTOP_TOKEN_PROTOCOL_PREFIX, DESKTOP_WS_PROTOCOL } from '../src/types.js'
import { WebSocketRelay, type WebSocketRelayOptions } from '../src/server/WebSocketRelay.js'

const TOPIC_A = 'A'.repeat(43)
const TOPIC_B = 'B'.repeat(43)

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

function stop(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  )
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
}

/** Ciphertexts of every envelope the socket receives, in order. */
function collect(socket: WebSocket): string[] {
  const received: string[] = []
  socket.on('message', data => {
    received.push((JSON.parse(`${data}`) as { ciphertext: string }).ciphertext)
  })
  return received
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for relay state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Relays started by a test, closed after it whether it passes or fails. */
const running: Array<{ server: http.Server; relay: WebSocketRelay }> = []

async function startRelay(
  options?: WebSocketRelayOptions
): Promise<{ relay: WebSocketRelay; port: number }> {
  const server = http.createServer()
  const relay = new WebSocketRelay(server, options)
  running.push({ server, relay })
  return { relay, port: await listen(server) }
}

describe('WebSocketRelay boundary and authority enforcement', () => {
  afterEach(async () => {
    for (const { server, relay } of running.splice(0)) {
      relay.close()
      server.closeAllConnections()
      if (server.listening) await stop(server)
    }
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN])(
    'rejects unsafe topic capacity %s',
    maxTopics => {
      const server = http.createServer()
      expect(() => new WebSocketRelay(server, { noServer: true, maxTopics })).toThrow(
        'maxTopics must be an integer'
      )
    }
  )

  it('selects only the stable desktop protocol and never echoes a bearer protocol', () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server, { noServer: true })
    const select = (relay as any).wss.options.handleProtocols as (
      protocols: Set<string>
    ) => string | false

    expect(select(new Set([DESKTOP_WS_PROTOCOL, `${DESKTOP_TOKEN_PROTOCOL_PREFIX}secret`]))).toBe(
      DESKTOP_WS_PROTOCOL
    )
    expect(select(new Set([`${DESKTOP_TOKEN_PROTOCOL_PREFIX}secret`]))).toBe(false)
    expect(select(new Set(['legacy-protocol']))).toBe('legacy-protocol')
    expect(select(new Set())).toBe(false)
    relay.close()
  })

  it('bounds buffered traffic, expires abandoned topics, and enforces the topic cap', () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server, { noServer: true, maxTopics: 1 })
    const envelope = { topic: TOPIC_A, ciphertext: 'AQID' }

    relay.sendToMobile(TOPIC_A, envelope)
    relay.sendToDesktop(TOPIC_A, envelope)
    for (let index = 0; index < 55; index++) relay.sendToMobile(TOPIC_A, envelope)
    expect((relay as any).topics.get(TOPIC_A).buffer).toHaveLength(50)
    expect(() => relay.sendToMobile(TOPIC_B, { ...envelope, topic: TOPIC_B })).toThrow(
      'topic limit'
    )

    ;(relay as any).topics.get(TOPIC_A).buffer.forEach((item: { expiresAt: number }) => {
      item.expiresAt = 0
    })
    ;(relay as any).runHeartbeat()
    expect((relay as any).topics.has(TOPIC_A)).toBe(false)

    expect(() =>
      relay.sendToDesktop(TOPIC_A, { topic: TOPIC_A, ciphertext: 'A'.repeat(65_536) })
    ).toThrow('exceeds 64 KiB')
    relay.close()
  })

  it('fails closed when validators throw and rejects sends after shutdown', () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server, { noServer: true })
    relay.onValidateTopic(() => {
      throw new Error('lookup failed')
    })
    relay.onValidateDesktopToken(() => {
      throw new Error('token store failed')
    })

    expect((relay as any).isTopicValid(TOPIC_A)).toBe(false)
    expect((relay as any).isDesktopTokenValid(TOPIC_A, 'token')).toBe(false)
    relay.close()
    relay.close()
    expect(() => relay.sendToMobile(TOPIC_A, { topic: TOPIC_A, ciphertext: 'AQID' })).toThrow(
      'relay is closed'
    )

    const socket = { destroy: jest.fn() }
    relay.handleUpgrade({} as never, socket as never, Buffer.alloc(0))
    expect(socket.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects conflicting query and subprotocol tokens', async () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server)
    relay.onValidateTopic(() => true)
    relay.onValidateDesktopToken(() => true)
    const port = await listen(server)
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop&token=query-token`,
      [DESKTOP_WS_PROTOCOL, `${DESKTOP_TOKEN_PROTOCOL_PREFIX}protocol-token`]
    )
    const closeResult = closed(socket)

    await opened(socket)
    await expect(closeResult).resolves.toEqual({
      code: 1008,
      reason: 'Conflicting desktop tokens'
    })

    relay.close()
    await stop(server)
  })

  it('preserves one mobile authority and rejects excess live topics', async () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server, { maxTopics: 1 })
    relay.onValidateTopic(() => true)
    const port = await listen(server)
    const first = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    await opened(first)

    const duplicate = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const duplicateClose = closed(duplicate)
    await opened(duplicate)
    await expect(duplicateClose).resolves.toEqual({
      code: 1008,
      reason: 'A mobile connection is already active'
    })

    const excess = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_B}&role=mobile`)
    const excessClose = closed(excess)
    await opened(excess)
    await expect(excessClose).resolves.toEqual({
      code: 1013,
      reason: 'Relay topic limit reached'
    })

    first.close()
    relay.close()
    await stop(server)
  })

  it('forwards desktop traffic to mobile immediately when the hold is not enabled', async () => {
    const { relay, port } = await startRelay()
    const desktop = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop`)
    await opened(desktop)
    desktop.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'AQID' }))
    await waitFor(() => (relay as any).topics.get(TOPIC_A)?.buffer.length === 1)

    const mobile = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const received = collect(mobile)
    await opened(mobile)
    desktop.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'BAUG' }))
    await waitFor(() => received.length === 2)
    expect(received).toEqual(['AQID', 'BAUG'])

    mobile.close()
    desktop.close()
  })

  it('holds desktop traffic until the mobile socket is accepted', async () => {
    const { relay, port } = await startRelay({ holdDesktopTrafficUntilAccepted: true })
    const connections: number[] = []
    relay.onIncoming((_topic, _envelope, role, connectionId) => {
      if (role === 'mobile') connections.push(connectionId)
    })
    const desktop = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop`)
    await opened(desktop)
    desktop.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'AQID' }))
    await waitFor(() => (relay as any).topics.get(TOPIC_A)?.buffer.length === 1)

    const mobile = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const received = collect(mobile)
    await opened(mobile)
    desktop.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'BAUG' }))
    mobile.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'BwgJ' }))
    await waitFor(() => connections.length === 1)
    // The relay's own sends are not held.
    relay.sendToMobile(TOPIC_A, { topic: TOPIC_A, ciphertext: 'CgsM' })
    await waitFor(() => received.length >= 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(received).toEqual(['CgsM'])

    expect(relay.isCurrentMobile(TOPIC_A, connections[0]!)).toBe(true)
    expect(relay.isCurrentMobile(TOPIC_A, connections[0]! + 1)).toBe(false)
    expect(relay.isCurrentMobile(TOPIC_B, connections[0]!)).toBe(false)
    expect(relay.acceptMobile(TOPIC_A, connections[0]! + 1)).toBe(false)
    expect(relay.acceptMobile(TOPIC_B, connections[0]!)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(received).toEqual(['CgsM'])

    expect(relay.acceptMobile(TOPIC_A, connections[0]!)).toBe(true)
    await waitFor(() => received.length === 3)
    expect(received).toEqual(['CgsM', 'AQID', 'BAUG'])
    desktop.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'DQ4P' }))
    await waitFor(() => received.length === 4)
    expect(received[3]).toBe('DQ4P')

    mobile.close()
    desktop.close()
  })

  it('drops held desktop traffic when an unaccepted mobile leaves and holds it for the next one', async () => {
    const { relay, port } = await startRelay({ holdDesktopTrafficUntilAccepted: true })
    const connections: number[] = []
    relay.onIncoming((_topic, _envelope, role, connectionId) => {
      if (role === 'mobile') connections.push(connectionId)
    })
    const desktop = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop`)
    await opened(desktop)

    const first = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const firstReceived = collect(first)
    const firstClosed = closed(first)
    await opened(first)
    desktop.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'AQID' }))
    await waitFor(() => (relay as any).topics.get(TOPIC_A)?.buffer.length === 1)
    relay.disconnectMobile(TOPIC_A)
    await firstClosed
    expect(firstReceived).toEqual([])
    expect((relay as any).topics.get(TOPIC_A)?.buffer ?? []).toHaveLength(0)

    const second = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const secondReceived = collect(second)
    await opened(second)
    desktop.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'BAUG' }))
    second.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'BwgJ' }))
    await waitFor(() => connections.length === 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(secondReceived).toEqual([])
    expect(relay.acceptMobile(TOPIC_A, connections[0]!)).toBe(true)
    await waitFor(() => secondReceived.length === 1)
    expect(secondReceived).toEqual(['BAUG'])

    // A socket that leaves on its own also discards what was held for it.
    const secondClosed = closed(second)
    second.close()
    await secondClosed
    const third = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const thirdClosed = closed(third)
    await opened(third)
    desktop.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'CgsM' }))
    await waitFor(() => (relay as any).topics.get(TOPIC_A)?.buffer.length === 1)
    // The id of the socket this one replaced does not accept it.
    expect(relay.acceptMobile(TOPIC_A, connections[0]!)).toBe(false)
    expect((relay as any).topics.get(TOPIC_A)?.buffer).toHaveLength(1)
    third.close()
    await thirdClosed
    await waitFor(() => ((relay as any).topics.get(TOPIC_A)?.buffer ?? []).length === 0)

    desktop.close()
  })

  it('hands held messages to a reconnecting desktop instead of the phone', async () => {
    const { relay, port } = await startRelay({ holdDesktopTrafficUntilAccepted: true })
    const connections: number[] = []
    relay.onIncoming((_topic, _envelope, role, connectionId) => {
      if (role === 'mobile') connections.push(connectionId)
    })
    const first = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop`)
    await opened(first)
    const mobile = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const received = collect(mobile)
    await opened(mobile)
    mobile.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'BwgJ' }))
    await waitFor(() => connections.length === 1)
    first.send(JSON.stringify({ topic: TOPIC_A, ciphertext: 'AQID' }))
    await waitFor(() => (relay as any).topics.get(TOPIC_A)?.buffer.length === 1)

    // Known behaviour: a desktop connecting during the hold receives the buffer.
    const second = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop`)
    const secondReceived = collect(second)
    await opened(second)
    await waitFor(() => secondReceived.length === 1)
    expect(secondReceived).toEqual(['AQID'])
    expect((relay as any).topics.get(TOPIC_A)?.buffer).toHaveLength(0)

    expect(relay.acceptMobile(TOPIC_A, connections[0]!)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(received).toEqual([])

    mobile.close()
    second.close()
  })

  it('contains mobile setup callback failures and replaces only authenticated desktops', async () => {
    const server = http.createServer()
    const relay = new WebSocketRelay(server)
    relay.onValidateTopic(() => true)
    relay.onMobileConnect(() => {
      throw new Error('auth state unavailable')
    })
    const port = await listen(server)
    const mobile = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=mobile`)
    const mobileClose = closed(mobile)
    await opened(mobile)
    await expect(mobileClose).resolves.toEqual({
      code: 1011,
      reason: 'Mobile connection setup failed'
    })

    const firstDesktop = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop`)
    await opened(firstDesktop)
    const firstClose = closed(firstDesktop)
    const replacement = new WebSocket(`ws://127.0.0.1:${port}/ws?topic=${TOPIC_A}&role=desktop`)
    await opened(replacement)
    await expect(firstClose).resolves.toEqual({
      code: 1008,
      reason: 'Replaced by a newer authenticated desktop connection'
    })

    replacement.close()
    relay.close()
    await stop(server)
  })
})
