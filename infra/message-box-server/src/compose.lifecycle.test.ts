import {
  closeMessageBoxWebSockets,
  createMessageBoxWebSocketOptions,
  disconnectAuthenticatedSockets
} from './compose.js'

describe('Message Box WebSocket lifecycle', () => {
  it('isolates authenticated sessions to each WebSocket connection', () => {
    const sessionManager = { getSession: jest.fn() }
    const wallet = { getPublicKey: jest.fn() }
    const options = createMessageBoxWebSocketOptions({ wallet, sessionManager } as never)

    expect(options.wallet).toBe(wallet)
    expect(options).not.toHaveProperty('sessionManager')
  })

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
