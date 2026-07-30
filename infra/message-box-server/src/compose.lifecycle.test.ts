import {
  closeMessageBoxWebSockets,
  disconnectAuthenticatedSockets
} from './compose.js'

describe('Message Box WebSocket lifecycle', () => {
  it('uses the package-owned close lifecycle when it is available', async () => {
    const close = jest.fn(async () => {})
    const server = { close }

    await closeMessageBoxWebSockets(server as never)

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('accepts disabled WebSockets as an already-closed lifecycle', async () => {
    await expect(closeMessageBoxWebSockets(null)).resolves.toBeUndefined()
  })

  it('force-disconnects every published AuthSocket compatibility socket', () => {
    const first = { ioSocket: { disconnect: jest.fn() } }
    const second = { ioSocket: { disconnect: jest.fn() } }

    disconnectAuthenticatedSockets([first, second] as never)

    expect(first.ioSocket.disconnect).toHaveBeenCalledWith(true)
    expect(second.ioSocket.disconnect).toHaveBeenCalledWith(true)
  })
})
