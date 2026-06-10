import type { WalletInterface, WalletProtocol } from '@bsv/sdk';

/** The cleartext that gets signed and echoed in the request body. */
export interface AuthSigData {
  /** Operation authorized, e.g. 'login' | 'create-user' | 'delete'. */
  action: string;
  /** Signer's identity public key (subject). */
  identityKey: string;
  /** Absolute expiry, ms since epoch. Cleartext; the signature makes it tamper-proof. */
  expiresAt: number;
  /** base64(32 random bytes); unique per request, enforces single-use server-side. */
  nonce: string;
}

export interface AuthProof {
  data: AuthSigData;
  signature: number[];
}

/**
 * A request body to bind into the signature, normalized to bytes before signing
 * (see `normalizeBody`):
 *   - `string` → UTF-8 bytes
 *   - `ArrayBuffer` / typed array → raw bytes (binary is preserved)
 *   - plain object or any array → JSON, then UTF-8 bytes
 *
 * Arrays are always treated as structured data (JSON), never as raw byte arrays —
 * pass binary as a typed array or `ArrayBuffer`.
 *
 * Client and verifier MUST bind identical bytes: the client signs the exact body
 * it sends, and the verifier binds the raw body it received (not a re-parsed and
 * re-serialized object). A swapped body fails verification.
 */
export type RequestBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | unknown[]
  | Record<string, unknown>;

export interface VerifyAuthProofResult {
  valid: boolean;
  identityKey?: string;
  error?: string;
}

/**
 * Records a nonce as consumed and returns whether it was fresh — `false` if the
 * nonce was already used (a replay). Sync or async.
 *
 * MUST be atomic: a single insert-if-not-exists (unique index / conditional
 * write), never a check-then-insert, or two concurrent requests carrying the
 * same nonce can both be accepted. In multi-instance / serverless deployments
 * the store MUST be shared across instances (e.g. a database with a unique
 * index); a per-process in-memory store is only safe for a single long-lived
 * instance.
 *
 * Keyed on `nonce` and retained only until `expiresAt` (e.g. a TTL index).
 */
export type ConsumeNonce = (nonce: string, expiresAt: Date) => boolean | Promise<boolean>;

export interface AuthProofOptions {
  /**
   * Signing protocol (security level 2 = bound to counterparty). MUST match on
   * client and server. Protocol names may only contain letters, numbers, spaces.
   */
  protocol?: WalletProtocol;
  /** Proof validity window in ms (default 120000 = 2 min). */
  windowMs?: number;
  /** Clock-skew tolerance in ms for the expiry bound (default 30000). */
  clockSkewMs?: number;
}

/** Client wallet methods needed to create a proof. */
export type ProofSignerWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

/** Server wallet method needed to verify a proof (ProtoWallet satisfies this). */
export interface ProofVerifierWallet {
  verifySignature: (args: {
    data: number[];
    signature: number[];
    protocolID: WalletProtocol;
    keyID: string;
    counterparty: string;
  }) => Promise<{ valid: boolean }>;
}

/**
 * Arguments for `createAuthProof`. Extends `AuthProofOptions`, so `protocol` /
 * `windowMs` / `clockSkewMs` may be set inline (or bound once via `AuthProofClient`).
 */
export interface CreateAuthProofArgs extends AuthProofOptions {
  /** Wallet that signs the proof. */
  wallet: ProofSignerWallet;
  /** The verifier's identity key the wallet signs toward. */
  counterparty: string;
  /** Operation being authorized, e.g. 'login'. */
  action: string;
  /** Optional request payload to bind into the signature; omit for bodyless actions. */
  body?: RequestBody;
}

/**
 * Arguments for `verifyAuthProof`. Extends `AuthProofOptions`, so `protocol` /
 * `windowMs` / `clockSkewMs` may be set inline (or bound once via `AuthProofServer`).
 */
export interface VerifyAuthProofArgs extends AuthProofOptions {
  /** Wallet that verifies the signature (a ProtoWallet for the verifier identity). */
  wallet: ProofVerifierWallet;
  /** The proof received from the client. */
  proof: AuthProof | undefined | null;
  /** The action the verifier expects this proof to authorize. */
  action: string;
  /** Single-use store hook; see `ConsumeNonce`. */
  consumeNonce: ConsumeNonce;
  /** Current time in ms (injectable for tests); defaults to `Date.now()`. */
  now?: number;
  /** The raw received request body, if the proof bound one; omit for bodyless actions. */
  body?: RequestBody;
}
