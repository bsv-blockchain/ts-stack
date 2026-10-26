import { PublicKey } from '@bsv/sdk'
import {
  containsControlCharacter,
  isCanonicalMessageBox,
  MAX_MESSAGE_BOX_BYTES
} from './messageFields.js'

export const MAX_WEB_SOCKET_MESSAGE_BOX_BYTES = MAX_MESSAGE_BOX_BYTES
export const MAX_WEB_SOCKET_ROOM_BYTES = 66 + 1 + MAX_WEB_SOCKET_MESSAGE_BOX_BYTES

export class WebSocketPolicyError extends Error {
  constructor(public readonly reason: string) {
    super(reason)
    this.name = 'WebSocketPolicyError'
  }
}

/**
 * Accept only the identity discovered by the signed BRC-103 transport. An
 * optional payload claim may confirm that identity, but can never replace it.
 */
export function authenticatedWebSocketIdentity(
  transportIdentity: unknown,
  claimedIdentity?: unknown
): string {
  if (typeof transportIdentity !== 'string' || transportIdentity.trim() === '') {
    throw new WebSocketPolicyError('Authenticated peer identity is unavailable')
  }

  let normalizedIdentity: string
  try {
    normalizedIdentity = PublicKey.fromString(transportIdentity).toString()
  } catch {
    throw new WebSocketPolicyError('Invalid authenticated identity key')
  }

  if (typeof claimedIdentity === 'string' && claimedIdentity.trim() !== normalizedIdentity) {
    throw new WebSocketPolicyError('Identity claim does not match authenticated peer')
  }

  return normalizedIdentity
}

export function isIdentityOwnedRoom(identityKey: string, roomId: unknown): roomId is string {
  if (
    typeof roomId !== 'string' ||
    roomId.trim() === '' ||
    Buffer.byteLength(roomId, 'utf8') > MAX_WEB_SOCKET_ROOM_BYTES
  ) {
    return false
  }
  const prefix = `${identityKey}-`
  if (!roomId.startsWith(prefix) || roomId.length <= prefix.length) return false
  const messageBox = roomId.slice(prefix.length)
  return isCanonicalMessageBox(messageBox) && !containsControlCharacter(identityKey)
}

export function messageBoxFromRecipientRoom(
  recipient: string,
  roomId: unknown
): string | undefined {
  let canonicalRecipient: string
  try {
    canonicalRecipient = PublicKey.fromString(recipient).toString()
  } catch {
    return undefined
  }
  if (canonicalRecipient !== recipient || !isIdentityOwnedRoom(canonicalRecipient, roomId)) {
    return undefined
  }
  return roomId.slice(canonicalRecipient.length + 1)
}
