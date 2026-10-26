import type { KeyPackageBytes, MlsCiphersuiteName } from '../types.js'

/**
 * Traffic that flows before a group exists.
 *
 * None of these carry a signature of their own. A response is
 * self-authenticating — the credential inside the KeyPackage carries its own
 * attestation — and the rest carry no key material. Sender authenticity for
 * requests and declines rests on the transport.
 */
export type BootstrapMessage =
  | {
      type: 'keyPackageRequest'
      requestId: string
      ciphersuites: MlsCiphersuiteName[]
      chatName?: string
    }
  | { type: 'keyPackageResponse'; requestId: string; keyPackage: KeyPackageBytes }
  | { type: 'keyPackageDecline'; requestId: string }
  | {
      type: 'welcome'
      requestId: string
      welcome: Uint8Array
      /** The inviter's name for the chat, so the joiner sees what they joined. */
      chatName?: string
    }

/** Everything the transport carries is one of these two. */
export type Envelope =
  { kind: 'bootstrap'; message: BootstrapMessage } | { kind: 'mls'; payload: Uint8Array }
