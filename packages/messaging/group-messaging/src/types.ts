/**
 * Shared public types for @bsv/group-messaging.
 *
 * The README ships with the package and covers the credential format, the wire
 * envelope and what each layer holds.
 */

/**
 * A participant's long-term secp256k1 identity key, as a compressed public key
 * in lowercase hex (66 characters). This is the form BRC-100 wallets return
 * from `getPublicKey({ identityKey: true })` and the form used throughout the
 * public API, including transport addressing.
 */
export type IdentityKey = string

/** Opaque identifier for a single application message. */
export type MessageId = string

export type Unsubscribe = () => void

/** Ciphersuite selection. `"default"` resolves to the v1 default (spec §7). */
export type CiphersuiteChoice = 'default' | MlsCiphersuiteName

/**
 * The subset of RFC 9420 ciphersuites this library supports. The v1 default is
 * `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (the RFC's mandatory-to-
 * implement suite); the P-256 suite is offered because it sits in a closer
 * algebraic family to secp256k1.
 */
export const SUPPORTED_CIPHERSUITES = [
  'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
  'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'
] as const

export type MlsCiphersuiteName = (typeof SUPPORTED_CIPHERSUITES)[number]

export const DEFAULT_CIPHERSUITE: MlsCiphersuiteName =
  'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'

/**
 * TLS-encoded RFC 9420 KeyPackage. Publishable and wire-compatible.
 *
 * Branded so it cannot be confused with {@link PrivateKeyPackageBytes}: sending
 * the wrong one is a catastrophe, and this makes it a compile error.
 */
export type KeyPackageBytes = Uint8Array & { readonly __brand: 'KeyPackage' }

/**
 * Bytes a transport is allowed to put on the wire.
 *
 * The optional, `undefined`-typed brand is what makes the guard bite. A bare
 * `Uint8Array` parameter accepts anything, branded or not, because
 * `Uint8Array & { __brand }` is assignable to `Uint8Array` — so spec §4.1's
 * requirement that `transport.send(peer, privateKeyPackage)` be a compile error
 * was not met. An optional property typed `undefined` inverts that: a plain
 * `Uint8Array` still passes, while {@link KeyPackageBytes} and
 * {@link PrivateKeyPackageBytes} are rejected, their `__brand` being a string.
 *
 * KeyPackages travel inside a bootstrap envelope, never as a bare payload, so
 * rejecting both brands costs nothing at any real call site.
 */
export type WirePayload = Uint8Array & { readonly __brand?: undefined }

/** Versioned opaque blob. Never transmitted, never stored by this library. */
export type PrivateKeyPackageBytes = Uint8Array & { readonly __brand: 'PrivateKeyPackage' }

/** RFC 9420 KeyPackageRef, hex. A hash — safe to log, index and transmit. */
export type KeyPackageRef = string

/** Application-chosen chat identifier. Local; never leaves the device. */
export type ChatId = string

/** MLS group identifier, hex. The only cross-party identifier. */
export type MlsGroupId = string

/** Local handle for one invitation. Never leaves the device. */
export type InviteId = string

export interface MintedKeyPackage {
  ref: KeyPackageRef
  keyPackage: KeyPackageBytes
  /** Yours to store. The library returns this once and retains nothing. */
  privateKeyPackage: PrivateKeyPackageBytes
  keyId: string
  ciphersuite: MlsCiphersuiteName
  lifetime: { notBefore: bigint; notAfter: bigint }
}

export interface KeyPackageOptions {
  ciphersuite?: MlsCiphersuiteName
  lifetimeSeconds?: number
}

export interface Member {
  identityKey: IdentityKey
  leafIndex: number
  /** BRC-43 key ID from this member's credential attestation. */
  keyId: string
}

export interface ChatInfo {
  chatId: ChatId
  mlsGroupId: MlsGroupId
  name: string | undefined
  epoch: bigint
  members: Member[]
}

/**
 * A bootstrap exchange (KeyPackage request, or a Welcome not yet joined) that
 * has not resolved into a chat yet.
 */
export interface PendingInvite {
  inviteId: InviteId
  direction: 'inbound' | 'outbound'
  kind: 'keyPackageRequest' | 'welcome'
  /** As reported by the transport — bootstrap envelopes carry no signature. */
  peer: IdentityKey
  /** Wire correlator. Alice mints it; Bob echoes it. */
  requestId: string
  chatName?: string
  ciphersuites?: MlsCiphersuiteName[]
  /**
   * On an inbound welcome: the ref of the KeyPackage it was encrypted to, so
   * the caller knows which private half to hand back to `joinFromWelcome`.
   * Filled in by the client, which is the only layer allowed to decode a
   * Welcome. Absent when none of this device's stored KeyPackages match.
   */
  ref?: KeyPackageRef
  /**
   * On an inbound welcome: the Welcome bytes, hex. Kept because joining is a
   * separate, user-gated step that may happen after a restart.
   */
  welcome?: string
  receivedAt: string
}
