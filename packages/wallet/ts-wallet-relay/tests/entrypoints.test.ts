import * as client from '../src/client.js'
import * as server from '../src/index.js'

describe('public entrypoints', () => {
  it('exposes the desktop protocol constants from both supported entrypoints', () => {
    expect(client.DESKTOP_WS_PROTOCOL).toBe(server.DESKTOP_WS_PROTOCOL)
    expect(client.DESKTOP_TOKEN_PROTOCOL_PREFIX).toBe(server.DESKTOP_TOKEN_PROTOCOL_PREFIX)
    expect(client.PROTOCOL_ID).toBe(server.PROTOCOL_ID)
  })

  it('keeps browser-safe client exports separate from server transports', () => {
    expect(client.WalletPairingSession).toBeDefined()
    expect(client.WalletRelayClient).toBeDefined()
    expect(server.WebSocketRelay).toBeDefined()
    expect(server.WalletRelayService).toBeDefined()
  })
})
