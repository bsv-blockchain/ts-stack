import type { WalletProtocol } from '@bsv/sdk'

/**
 * BRC-43 protocol ID for this library.
 *
 * Security level 2 means the wallet asks the user for permission per
 * counterparty, which is what a messaging protocol wants.
 *
 * The name is `"group messaging"` with a space, not a hyphen. BRC-43 protocol
 * names are validated against `/^[a-z0-9 ]+$/` by `@bsv/sdk`, so the spec's
 * suggested `"group-messaging"` and `"bsv.group-messaging.v1"` are both
 * rejected at runtime. Versioning therefore lives in the key ID, which has no
 * character restriction.
 */
export const GROUP_MESSAGING_PROTOCOL: WalletProtocol = [2, 'group messaging']

/** Key ID prefix for credential attestations. */
export const CREDENTIAL_KEY_ID_PREFIX = 'credential v1 '

/**
 * A fresh key ID for one KeyPackage's credential attestation. Key IDs double as
 * KeyPackage rotation identifiers (spec §3), so each KeyPackage gets its own.
 */
export const newCredentialKeyId = (): string => {
  const random = new Uint8Array(16)
  crypto.getRandomValues(random)
  const hex = Array.from(random, b => b.toString(16).padStart(2, '0')).join('')
  return `${CREDENTIAL_KEY_ID_PREFIX}${hex}`
}
