import { PeerSession } from '@bsv/sdk'

/**
 * Durable representation of a BRC-103 peer session.
 *
 * The session nonce is the authoritative key. `lastUpdate` also acts as the
 * optimistic-write version so a delayed request from one replica cannot
 * overwrite newer authentication state written by another replica.
 */
export interface TableAuthSession {
  sessionNonce: string
  peerNonce?: string | null
  peerIdentityKey?: string | null
  isAuthenticated: boolean | number
  lastUpdate: number | string
  certificatesRequired?: boolean | number | null
  certificatesValidated?: boolean | number | null
  expiresAt: number | string
}

export function tableAuthSessionToPeerSession (row: TableAuthSession): PeerSession {
  return {
    sessionNonce: row.sessionNonce,
    peerNonce: row.peerNonce ?? undefined,
    peerIdentityKey: row.peerIdentityKey ?? undefined,
    isAuthenticated: Boolean(row.isAuthenticated),
    lastUpdate: Number(row.lastUpdate),
    certificatesRequired: row.certificatesRequired == null ? undefined : Boolean(row.certificatesRequired),
    certificatesValidated: row.certificatesValidated == null ? undefined : Boolean(row.certificatesValidated)
  }
}
