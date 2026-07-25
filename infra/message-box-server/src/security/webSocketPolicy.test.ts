import { PrivateKey } from '@bsv/sdk'
import {
  authenticatedWebSocketIdentity,
  isIdentityOwnedRoom,
  messageBoxFromRecipientRoom,
  recipientSocketIds,
  WebSocketPolicyError
} from './webSocketPolicy.js'

describe('Message Box WebSocket policy', () => {
  const authenticatedIdentity = PrivateKey.fromRandom().toPublicKey().toString()
  const otherIdentity = PrivateKey.fromRandom().toPublicKey().toString()

  it('uses the signed transport identity and accepts a matching claim', () => {
    expect(authenticatedWebSocketIdentity(
      authenticatedIdentity,
      authenticatedIdentity
    )).toBe(authenticatedIdentity)
  })

  it('rejects a payload identity that differs from the signed peer', () => {
    expect(() => authenticatedWebSocketIdentity(
      authenticatedIdentity,
      otherIdentity
    )).toThrow(new WebSocketPolicyError(
      'Identity claim does not match authenticated peer'
    ))
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
    expect(isIdentityOwnedRoom(
      authenticatedIdentity,
      `${authenticatedIdentity}-payment_inbox`
    )).toBe(true)
    expect(isIdentityOwnedRoom(authenticatedIdentity, `${authenticatedIdentity}-`)).toBe(false)
    expect(isIdentityOwnedRoom(
      authenticatedIdentity,
      `${otherIdentity}-payment_inbox`
    )).toBe(false)
  })

  it('derives a message box only from the recipient-owned room', () => {
    expect(messageBoxFromRecipientRoom(
      authenticatedIdentity,
      `${authenticatedIdentity}-payment_inbox`
    )).toBe('payment_inbox')
    expect(messageBoxFromRecipientRoom(
      authenticatedIdentity,
      `${otherIdentity}-payment_inbox`
    )).toBeUndefined()
  })

  it('selects only sockets authenticated as the recipient', () => {
    const sockets = new Map([
      ['sender', otherIdentity],
      ['recipient-1', authenticatedIdentity],
      ['recipient-2', authenticatedIdentity],
      ['unrelated', otherIdentity]
    ])

    expect(recipientSocketIds(sockets, authenticatedIdentity)).toEqual([
      'recipient-1',
      'recipient-2'
    ])
  })
})
