import {
  closeMessageBoxWebSockets,
  canonicalizeAuthenticatedIdentity,
  createMessageBoxWebSocketOptions,
  disconnectAuthenticatedSockets,
  validateWebSocketMessage
} from './compose.js'
import { PrivateKey } from '@bsv/sdk'

describe('Message Box WebSocket lifecycle', () => {
  it('isolates authenticated sessions to each WebSocket connection', () => {
    const sessionManager = { getSession: jest.fn() }
    const wallet = { getPublicKey: jest.fn() }
    const options = createMessageBoxWebSocketOptions({ wallet, sessionManager } as never)

    expect(options.wallet).toBe(wallet)
    expect(options).not.toHaveProperty('sessionManager')
  })

  it('canonicalizes compatible authenticated public-key encodings once for every route', () => {
    const key = PrivateKey.fromRandom().toPublicKey()
    const req = { auth: { identityKey: key.encode(false, 'hex') } }
    const next = jest.fn()

    canonicalizeAuthenticatedIdentity(req as never, {} as never, next)

    expect(req.auth.identityKey).toBe(key.toString())
    expect(next).toHaveBeenCalledTimes(1)
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

  it('requires canonical bounded live-message envelope fields', () => {
    const recipient = PrivateKey.fromRandom().toPublicKey().toString()
    const roomId = `${recipient}-inbox`
    expect(
      validateWebSocketMessage(
        roomId,
        { recipient, messageId: 'message-1', body: 'ciphertext' },
        1024
      )
    ).toBeNull()
    expect(
      validateWebSocketMessage(roomId, { recipient, messageId: 'bad\n', body: 'ciphertext' }, 1024)
    ).toEqual({ reason: 'Invalid message ID' })
    expect(
      validateWebSocketMessage(
        roomId,
        { recipient, messageId: 'message-1', body: 'x'.repeat(1025) },
        1024
      )
    ).toEqual({ reason: 'Invalid message body' })
  })

  it('does not invoke live-message field accessors during validation', () => {
    const recipient = PrivateKey.fromRandom().toPublicKey().toString()
    const hostile = Object.defineProperty({}, 'recipient', {
      get: () => {
        throw new Error('recipient accessor invoked')
      }
    })

    expect(() => validateWebSocketMessage(`${recipient}-inbox`, hostile, 1024)).not.toThrow()
    expect(validateWebSocketMessage(`${recipient}-inbox`, hostile, 1024)).toEqual({
      reason: 'Invalid message body'
    })
  })
})
