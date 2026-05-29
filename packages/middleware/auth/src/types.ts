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
