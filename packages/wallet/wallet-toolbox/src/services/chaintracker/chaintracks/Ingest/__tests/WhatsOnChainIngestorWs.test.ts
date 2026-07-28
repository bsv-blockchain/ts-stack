const mockSockets: Array<{
  send: jest.Mock
  close: jest.Mock
  onopen?: (event: unknown) => void
  onclose?: (event: unknown) => void
  onmessage?: (event: { data: unknown }) => void
}> = []

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const socket = {
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
    const listener = WocHeadersBulkListener(0, 10, enqueue, error, stop, 'main', logger, 1)
    const socket = mockSockets[0]

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
            hash: 'hash',
            height: 10,
            version: 1,
            merkleroot: 'merkle-root',
            time: 1,
            bits: '1d00ffff',
            nonce: 1,
            previousblockhash: 'previous-hash'
          }
        }
      })
    })
    socket.onmessage?.({ data: '{}' })

    await jest.advanceTimersByTimeAsync(1)
    await expect(listener).resolves.toBe(true)
    expect(socket.send).toHaveBeenCalledWith('ping')
    expect(logger).toHaveBeenCalledWith(JSON.stringify({ connect: true }))
    expect(error).toHaveBeenCalledWith(42, `unknown data ${JSON.stringify({ unexpected: true })}`)
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ height: 10 }))

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
})
