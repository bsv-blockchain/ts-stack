import { PublicKey } from '@bsv/sdk'

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
  if (typeof roomId !== 'string' || roomId.trim() === '') return false
  const prefix = `${identityKey}-`
  return roomId.startsWith(prefix) && roomId.length > prefix.length
}

export function messageBoxFromRecipientRoom(
  recipient: string,
  roomId: unknown
): string | undefined {
  if (!isIdentityOwnedRoom(recipient, roomId)) return undefined
  return roomId.slice(recipient.length + 1)
}

export function recipientSocketIds(
  authenticatedSockets: ReadonlyMap<string, string>,
  recipientIdentity: string
): string[] {
  return [...authenticatedSockets.entries()]
    .filter(([, identityKey]) => identityKey === recipientIdentity)
    .map(([socketId]) => socketId)
}
