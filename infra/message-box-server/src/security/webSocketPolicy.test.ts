import { PrivateKey } from '@bsv/sdk'
import {
  authenticatedWebSocketIdentity,
  isIdentityOwnedRoom,
  MAX_WEB_SOCKET_MESSAGE_BOX_BYTES,
  messageBoxFromRecipientRoom,
  WebSocketPolicyError
} from './webSocketPolicy.js'

describe('Message Box WebSocket policy', () => {
  const authenticatedIdentity = PrivateKey.fromRandom().toPublicKey().toString()
  const otherIdentity = PrivateKey.fromRandom().toPublicKey().toString()

  it('uses the signed transport identity and accepts a matching claim', () => {
    expect(authenticatedWebSocketIdentity(authenticatedIdentity, authenticatedIdentity)).toBe(
      authenticatedIdentity
    )
  })

  it('rejects a payload identity that differs from the signed peer', () => {
    expect(() => authenticatedWebSocketIdentity(authenticatedIdentity, otherIdentity)).toThrow(
      new WebSocketPolicyError('Identity claim does not match authenticated peer')
    )
  })

  it('rejects absent and malformed transport identities', () => {
    expect(() => authenticatedWebSocketIdentity(undefined)).toThrow(
      'Authenticated peer identity is unavailable'
    )
    expect(() => authenticatedWebSocketIdentity('not-a-public-key')).toThrow(
      'Invalid authenticated identity key'
    )
  })

  it('limits room access to a non-empty box owned by the identity', () => {
    expect(
      isIdentityOwnedRoom(authenticatedIdentity, `${authenticatedIdentity}-payment_inbox`)
    ).toBe(true)
    expect(isIdentityOwnedRoom(authenticatedIdentity, `${authenticatedIdentity}-`)).toBe(false)
    expect(isIdentityOwnedRoom(authenticatedIdentity, `${otherIdentity}-payment_inbox`)).toBe(false)
    expect(isIdentityOwnedRoom(authenticatedIdentity, `${authenticatedIdentity}- inbox`)).toBe(
      false
    )
    expect(isIdentityOwnedRoom(authenticatedIdentity, `${authenticatedIdentity}-inbox\n`)).toBe(
      false
    )
    expect(
      isIdentityOwnedRoom(
        authenticatedIdentity,
        `${authenticatedIdentity}-${'x'.repeat(MAX_WEB_SOCKET_MESSAGE_BOX_BYTES + 1)}`
      )
    ).toBe(false)
  })

  it('derives a message box only from the recipient-owned room', () => {
    expect(
      messageBoxFromRecipientRoom(authenticatedIdentity, `${authenticatedIdentity}-payment_inbox`)
    ).toBe('payment_inbox')
    expect(
      messageBoxFromRecipientRoom(authenticatedIdentity, `${otherIdentity}-payment_inbox`)
    ).toBeUndefined()
    const uncompressed = PrivateKey.fromRandom().toPublicKey().encode(false, 'hex') as string
    expect(
      messageBoxFromRecipientRoom(uncompressed, `${uncompressed}-payment_inbox`)
    ).toBeUndefined()
  })
})
