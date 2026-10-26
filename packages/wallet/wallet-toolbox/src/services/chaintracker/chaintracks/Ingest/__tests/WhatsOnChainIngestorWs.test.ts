const mockSockets: Array<{
  url?: string
  options?: Record<string, unknown>
  send: jest.Mock
  close: jest.Mock
  onopen?: (event: unknown) => void
  onclose?: (event: unknown) => void
  onmessage?: (event: { data: unknown }) => void
}> = []

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((url: string, options?: Record<string, unknown>) => {
    const socket = {
      url,
      options,
      send: jest.fn(),
      close: jest.fn(),
      onopen: undefined,
      onclose: undefined,
      onmessage: undefined
    }
    socket.close.mockImplementation(() => socket.onclose?.({}))
    mockSockets.push(socket)
    return socket
  })
}))

import {
  createStopHandler,
  type StopListenerToken,
  WocHeadersBulkListener,
  WocHeadersLiveListener
} from '../WhatsOnChainIngestorWs'
import { genesisHeader } from '../../util/blockHeaderUtilities'
import { LiveIngestorWhatsOnChainWs } from '../LiveIngestorWhatsOnChainWs'
import { BulkIngestorWhatsOnChainWs } from '../BulkIngestorWhatsOnChainWs'
import { HeightRange } from '../../util/HeightRange'
import { deserializeBlockHeader } from '../../util/blockHeaderUtilities'
import { readFileSync } from 'node:fs'

describe('WhatsOnChain WebSocket listener stops', () => {
  afterEach(() => {
    jest.useRealTimers()
    mockSockets.length = 0
  })

  test('closes an open listener and completes an unopened listener', () => {
    const markOk = jest.fn()
    const markClosed = jest.fn()
    const close = jest.fn()
    const markDone = jest.fn()

    createStopHandler(markOk, () => true, markClosed, close, markDone)()

    expect(markOk).toHaveBeenCalledTimes(1)
    expect(markClosed).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(markDone).not.toHaveBeenCalled()

    createStopHandler(markOk, () => false, markClosed, close, markDone)()

    expect(markOk).toHaveBeenCalledTimes(2)
    expect(markDone).toHaveBeenCalledTimes(1)
  })

  test('installs a usable stop callback before rejecting an unsupported bulk chain', async () => {
    const stop: StopListenerToken = { stop: undefined }

    await expect(WocHeadersBulkListener(0, 1, jest.fn(), () => false, stop, 'mock', jest.fn(), 0)).rejects.toThrow(
      "WocHeadersBulkListener does not support 'mock' chain."
    )

    expect(stop.stop).toEqual(expect.any(Function))
    stop.stop?.()
  })

  test('applies the bulk listener defaults before rejecting an unsupported chain', async () => {
    const stop: StopListenerToken = { stop: undefined }

    await expect(WocHeadersBulkListener(0, 1, jest.fn(), () => false, stop, 'mock')).rejects.toThrow(
      "WocHeadersBulkListener does not support 'mock' chain."
    )

    expect(stop.stop).toEqual(expect.any(Function))
  })

  test('installs a usable stop callback before rejecting an unsupported live chain', async () => {
    const stop: StopListenerToken = { stop: undefined }

    await expect(WocHeadersLiveListener(jest.fn(), () => false, stop, 'mock', jest.fn(), 0)).rejects.toThrow(
      "WocHeadersLiveListener does not support 'mock' chain."
    )

    expect(stop.stop).toEqual(expect.any(Function))
    stop.stop?.()
  })

  test('closes open bulk and live sockets through their installed stop callbacks', async () => {
    jest.useFakeTimers()

    const bulkStop: StopListenerToken = { stop: undefined }
    const bulk = WocHeadersBulkListener(0, 1, jest.fn(), () => false, bulkStop, 'main', jest.fn(), 1)
    const bulkSocket = mockSockets[0]
    bulkSocket.onopen?.({})
    bulkStop.stop?.()
    await jest.advanceTimersByTimeAsync(1)
    await expect(bulk).resolves.toBe(true)
    expect(bulkSocket.close).toHaveBeenCalledTimes(1)

    const liveStop: StopListenerToken = { stop: undefined }
    const live = WocHeadersLiveListener(jest.fn(), () => false, liveStop, 'main', jest.fn(), 1)
    const liveSocket = mockSockets[1]
    liveSocket.onopen?.({})
    liveStop.stop?.()
    await jest.advanceTimersByTimeAsync(1000)
    await expect(live).resolves.toBe(true)
    expect(liveSocket.close).toHaveBeenCalledTimes(1)
  })

  test('processes bulk control, header, and error frames', async () => {
    jest.useFakeTimers()
    const enqueue = jest.fn()
    const error = jest.fn(() => false)
    const logger = jest.fn()
    const stop: StopListenerToken = { stop: undefined }
    const listener = WocHeadersBulkListener(0, 0, enqueue, error, stop, 'main', logger, 1)
    const socket = mockSockets[0]

    expect(socket.options).toMatchObject({
      followRedirects: false,
      handshakeTimeout: 30000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false
    })

    socket.onopen?.({})
    socket.onmessage?.({ data: '' })
    socket.onmessage?.({ data: '{}' })
    socket.onmessage?.({ data: JSON.stringify({ connect: true }) })
    socket.onmessage?.({ data: JSON.stringify({ unexpected: true }) })
    socket.onmessage?.({ data: JSON.stringify({ pub: {} }) })
    socket.onmessage?.({ data: JSON.stringify({ type: 3 }) })
    socket.onmessage?.({ data: JSON.stringify({ type: 5 }) })
    socket.onmessage?.({ data: JSON.stringify({ type: 6 }) })
    socket.onmessage?.({
      data: JSON.stringify({
        pub: {
          data: {
            ...wocGenesisHeader()
          }
        }
      })
    })
    socket.onmessage?.({ data: '{}' })

    await jest.advanceTimersByTimeAsync(1)
    await expect(listener).resolves.toBe(true)
    expect(socket.send).toHaveBeenCalledWith('ping')
    expect(logger).toHaveBeenCalledWith('WhatsOnChain WebSocket connected.')
    expect(error).toHaveBeenCalledWith(42, 'unknown WhatsOnChain data frame')
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ height: 0 }))

    for (const frame of [{ type: 7, data: { code: 503 } }, { type: 9 }]) {
      const nextStop: StopListenerToken = { stop: undefined }
      const nextError = jest.fn(() => false)
      const nextListener = WocHeadersBulkListener(0, 10, jest.fn(), nextError, nextStop, 'main', jest.fn(), 1)
      const nextSocket = mockSockets.at(-1)!
      nextSocket.onmessage?.({ data: JSON.stringify(frame) })
      await jest.advanceTimersByTimeAsync(1)
      await expect(nextListener).resolves.toBe(false)
      expect(nextError).toHaveBeenCalled()
      expect(nextSocket.close).toHaveBeenCalledTimes(1)
    }
  })

  test('reports a bulk listener that goes idle before its first header', async () => {
    jest.useFakeTimers()
    const error = jest.fn(() => false)
    const stop: StopListenerToken = { stop: undefined }
    const listener = WocHeadersBulkListener(0, 10, jest.fn(), error, stop, 'main', jest.fn(), 1)

    await jest.advanceTimersByTimeAsync(15)

    await expect(listener).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith(-2, 'unexpectedly went idle')
  })

  test('closes malformed and idle live connections without throwing from event handlers', async () => {
    jest.useFakeTimers()
    const malformedError = jest.fn(() => false)
    const malformed = WocHeadersLiveListener(jest.fn(), malformedError, { stop: undefined }, 'main', jest.fn(), 5)
    const malformedSocket = mockSockets[0]
    expect(() => malformedSocket.onmessage?.({ data: '{' })).not.toThrow()
    await jest.advanceTimersByTimeAsync(1000)
    await expect(malformed).resolves.toBe(false)
    expect(malformedError).toHaveBeenCalledWith(-3, expect.stringContaining('invalid WhatsOnChain WebSocket message'))

    const idleError = jest.fn(() => false)
    const idle = WocHeadersLiveListener(jest.fn(), idleError, { stop: undefined }, 'main', jest.fn(), 5)
    const idleSocket = mockSockets[1]
    idleSocket.onopen?.({})
    await jest.advanceTimersByTimeAsync(1000)
    await expect(idle).resolves.toBe(false)
    expect(idleError).toHaveBeenCalledWith(-2, 'unexpectedly went idle')
    expect(idleSocket.close).toHaveBeenCalled()
  })

  test('bounds the legacy live adapter queue and stops it during shutdown', async () => {
    jest.useFakeTimers()
    const options = LiveIngestorWhatsOnChainWs.createLiveIngestorWhatsOnChainOptions('main')
    options.idleWait = 1000
    options.maxQueuedHeaders = 1
    const ingestor = new LiveIngestorWhatsOnChainWs(options)
    const logs: string[] = []
    ingestor.log = message => logs.push(String(message))
    const liveHeaders: any[] = []
    const listening = ingestor.startListening(liveHeaders)
    const socket = mockSockets[0]
    socket.onopen?.({})
    socket.onmessage?.({ data: JSON.stringify({ pub: { data: wocGenesisHeader() } }) })
    socket.onmessage?.({ data: JSON.stringify({ pub: { data: wocHeader(realHeader(1)) } }) })
    await ingestor.shutdown()
    await jest.advanceTimersByTimeAsync(1000)
    await expect(listening).resolves.toBeUndefined()

    expect(liveHeaders).toHaveLength(1)
    expect(logs.some(log => log.includes('queue capacity 1 reached'))).toBe(true)
    expect(socket.close).toHaveBeenCalled()
  })

  test('chunks legacy bulk history so no connection or admission batch grows without bound', async () => {
    jest.useFakeTimers()
    const options = BulkIngestorWhatsOnChainWs.createBulkIngestorWhatsOnChainOptions('main')
    options.idleWait = 1
    options.maxHeadersPerRequest = 1
    const ingestor = new BulkIngestorWhatsOnChainWs(options)
    const addBulkHeaders = jest.fn(async (headers: any[], _range: HeightRange, live: any[]) => [...live, ...headers])
    await ingestor.setStorage({ addBulkHeaders } as any, jest.fn())

    const result = ingestor.fetchHeaders(
      { bulk: new HeightRange(0, -1), live: new HeightRange(0, -1) },
      new HeightRange(0, 1),
      new HeightRange(0, 1),
      []
    )
    mockSockets[0].onopen?.({})
    mockSockets[0].onmessage?.({ data: JSON.stringify({ pub: { data: wocGenesisHeader() } }) })
    await jest.advanceTimersByTimeAsync(1)
    expect(mockSockets).toHaveLength(2)
    mockSockets[1].onopen?.({})
    mockSockets[1].onmessage?.({ data: JSON.stringify({ pub: { data: wocHeader(realHeader(1)) } }) })
    await jest.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toHaveLength(2)
    expect(addBulkHeaders).toHaveBeenCalledTimes(2)
    expect(mockSockets.map(socket => socket.url)).toEqual([
      expect.stringContaining('from=0&to=0'),
      expect.stringContaining('from=1&to=1')
    ])
  })
})

function wocGenesisHeader(): Record<string, unknown> {
  return wocHeader(genesisHeader('main'))
}

const fixture = new Uint8Array(
  readFileSync('src/services/chaintracker/chaintracks/__tests/data/cdnTest499/mainNet_0.headers')
)

function realHeader(height: number) {
  return deserializeBlockHeader(fixture, height, height * 80)
}

function wocHeader(header: ReturnType<typeof genesisHeader>): Record<string, unknown> {
  return {
    hash: header.hash,
    height: header.height,
    version: header.version,
    merkleroot: header.merkleRoot,
    time: header.time,
    bits: header.bits.toString(16).padStart(8, '0'),
    nonce: header.nonce,
    previousblockhash: header.previousHash
  }
}
