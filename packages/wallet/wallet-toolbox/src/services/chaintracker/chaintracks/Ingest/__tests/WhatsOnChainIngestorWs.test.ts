const mockSockets: Array<{
  send: jest.Mock
  close: jest.Mock
  onopen?: (event: unknown) => void
  onclose?: (event: unknown) => void
}> = []

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const socket = {
      send: jest.fn(),
      close: jest.fn(),
      onopen: undefined,
      onclose: undefined
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
})
