import { Validation } from '@bsv/sdk'
import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'

export const BRC177_NO_SEND_EXPIRY_PREFIX = 'p nosend expiry '
export const BRC177_NO_SEND_MODULE_PREFIX = 'p nosend '

export type Brc177NoSendExpiryMode = 'seconds' | 'timestamp' | 'blockheight'

export interface Brc177NoSendExpiry {
  mode: Brc177NoSendExpiryMode
  value: number
  label: string
}

export type Brc177NoSendExpiryState =
  | 'preparing'
  | 'unsigned'
  | 'signed'
  | 'revocation-requested'
  | 'broadcast'
  | 'reclaiming'
  | 'reclaimed'
  | 'target-won'
  | 'conflicted'
  | 'cancelled'

/**
 * Orders durable lifecycle states by safety progress for cross-storage merge.
 * A newer wall-clock timestamp must never revive a state from which a signed
 * target could escape expiry enforcement.
 */
export function brc177NoSendExpiryStateRank(state: Brc177NoSendExpiryState | undefined): number {
  switch (state) {
    case 'preparing':
      return 0
    case 'unsigned':
      return 1
    case 'cancelled':
      return 2
    case 'signed':
      return 3
    case 'revocation-requested':
      return 4
    case 'conflicted':
      return 5
    case 'broadcast':
      return 6
    case 'reclaiming':
      return 7
    case 'reclaimed':
      return 8
    // If synchronized stores ever carry contradictory terminal observations,
    // preserving the target winner is conservative: it never exposes the
    // reclaim output as spendable on possibly stale proof evidence.
    case 'target-won':
      return 9
    default:
      return -1
  }
}

export interface Brc177FundingCreateActionMetadata {
  kind: 'funding'
  anchorSatoshis: number
}

export interface Brc177ProtectedCreateActionMetadata {
  kind: 'protected'
  expiry: Brc177NoSendExpiry
  deadline: number
  anchorTxid: string
  anchorVout: number
}

export type Brc177CreateActionMetadata = Brc177FundingCreateActionMetadata | Brc177ProtectedCreateActionMetadata

export type Brc177ValidCreateActionArgs = Validation.ValidCreateActionArgs & {
  brc177?: Brc177CreateActionMetadata
}

function parseCanonicalUnsignedInteger(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new WERR_INVALID_PARAMETER('labels', 'a canonical unsigned BRC-177 expiry value')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new WERR_INVALID_PARAMETER('labels', 'a safely supported BRC-177 expiry value')
  }
  return parsed
}

export function parseBrc177NoSendExpiryLabels(labels: string[] | undefined): Brc177NoSendExpiry | undefined {
  const moduleLabels = (labels ?? []).filter(label => label.startsWith(BRC177_NO_SEND_MODULE_PREFIX))
  if (moduleLabels.length === 0) return undefined
  const matching = (labels ?? []).filter(label => label.startsWith(BRC177_NO_SEND_EXPIRY_PREFIX))
  if (matching.length !== 1 || moduleLabels.length !== 1) {
    throw new WERR_INVALID_PARAMETER('labels', 'exactly one BRC-177 noSend expiry label')
  }

  const label = matching[0]
  const remainder = label.slice(BRC177_NO_SEND_EXPIRY_PREFIX.length)
  const separator = remainder.indexOf(' ')
  if (separator <= 0 || separator === remainder.length - 1 || remainder.includes(' ', separator + 1)) {
    throw new WERR_INVALID_PARAMETER('labels', 'a valid BRC-177 noSend expiry label')
  }

  const mode = remainder.slice(0, separator)
  if (mode !== 'seconds' && mode !== 'timestamp' && mode !== 'blockheight') {
    throw new WERR_INVALID_PARAMETER('labels', 'a supported BRC-177 expiry mode')
  }
  const value = parseCanonicalUnsignedInteger(remainder.slice(separator + 1))
  if (mode === 'seconds' && value === 0) {
    throw new WERR_INVALID_PARAMETER('labels', 'a BRC-177 seconds duration greater than zero')
  }
  return { mode, value, label }
}

export function hasBrc177NoSendExpiryLabel(labels: string[] | undefined): boolean {
  return (labels ?? []).some(label => label.startsWith(BRC177_NO_SEND_MODULE_PREFIX))
}
