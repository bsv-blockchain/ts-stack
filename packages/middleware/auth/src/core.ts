import { Utils, Random, type WalletProtocol } from '@bsv/sdk';
import { DEFAULT_PROTOCOL, DEFAULT_WINDOW_MS, DEFAULT_CLOCK_SKEW_MS } from './constants.js';
import type {
  AuthProof,
  AuthProofOptions,
  AuthSigData,
  ConsumeNonce,
  ProofSignerWallet,
  ProofVerifierWallet,
  VerifyAuthProofResult,
} from './types.js';

interface ResolvedOptions {
  protocol: WalletProtocol;
  windowMs: number;
  clockSkewMs: number;
}

function resolveOptions(options: AuthProofOptions = {}): ResolvedOptions {
  return {
    protocol: options.protocol ?? DEFAULT_PROTOCOL,
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
    clockSkewMs: options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
  };
}

/** Canonical bytes both sides hash. Fixed field order; '\n' is a safe delimiter. */
export function serializeAuthSigData(data: AuthSigData): number[] {
  const canonical = [data.action, data.identityKey, String(data.expiresAt), data.nonce].join('\n');
  return Utils.toArray(canonical, 'utf8');
}

/** Builds the per-request signable data: fresh expiry + strong random nonce. */
export function createAuthSigData(
  action: string,
  identityKey: string,
  options?: AuthProofOptions,
  now: number = Date.now(),
): AuthSigData {
  const { windowMs } = resolveOptions(options);
  return {
    action,
    identityKey,
    expiresAt: now + windowMs,
    nonce: Utils.toBase64(Random(32)),
  };
}

/** Pure check of shape, action, and freshness. Signature + single-use checked separately. */
export function checkAuthSigData(
  data: AuthSigData | undefined | null,
  expectedAction: string,
  now: number,
  options?: AuthProofOptions,
): { valid: boolean; error?: string } {
  const { windowMs, clockSkewMs } = resolveOptions(options);

  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Malformed proof' };
  }
  const { action, identityKey, expiresAt, nonce } = data;
  if (
    typeof action !== 'string' ||
    typeof identityKey !== 'string' || identityKey.length === 0 ||
    typeof nonce !== 'string' || nonce.length === 0
  ) {
    return { valid: false, error: 'Malformed proof' };
  }
  if (action !== expectedAction) {
    return { valid: false, error: 'Action mismatch' };
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { valid: false, error: 'Malformed proof' };
  }
  if (now >= expiresAt) {
    return { valid: false, error: 'Proof expired' };
  }
  // Reject expiry beyond the window — stops a client minting a long-lived proof.
  if (expiresAt - now > windowMs + clockSkewMs) {
    return { valid: false, error: 'Proof expiry too far in the future' };
  }
  return { valid: true };
}

/**
 * Client-side: build a signed proof authorizing `action` for this wallet.
 * `counterparty` is the verifier's identity key (e.g. your backend) that the
 * wallet signs toward — relative to the wallet, so it's a different key than the
 * server passes to verify (there the counterparty is this signer's identity).
 */
export async function createAuthProof(
  wallet: ProofSignerWallet,
  counterparty: string,
  action: string,
  options?: AuthProofOptions,
): Promise<AuthProof> {
  const { protocol } = resolveOptions(options);
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
  const data = createAuthSigData(action, identityKey, options);

  const { signature } = await wallet.createSignature({
    data: serializeAuthSigData(data),
    protocolID: protocol,
    keyID: data.nonce,
    counterparty,
  });

  return { data, signature };
}

/**
 * Server-side: verify a proof. Steps: shape/action/freshness → signature →
 * single-use (via the injected `consumeNonce`). Returns the authenticated
 * identityKey on success. `deps.now` is injectable for tests.
 */
export async function verifyAuthProof(
  wallet: ProofVerifierWallet,
  proof: AuthProof | undefined | null,
  expectedAction: string,
  deps: { consumeNonce: ConsumeNonce; now?: number },
  options?: AuthProofOptions,
): Promise<VerifyAuthProofResult> {
  const { protocol } = resolveOptions(options);
  const now = deps.now ?? Date.now();

  if (!proof || typeof proof !== 'object' || !proof.data || !Array.isArray(proof.signature)) {
    return { valid: false, error: 'Malformed proof' };
  }

  const shape = checkAuthSigData(proof.data, expectedAction, now, options);
  if (!shape.valid) {
    return { valid: false, error: shape.error };
  }

  const { identityKey, nonce, expiresAt } = proof.data;

  // identityKey and signature come from the request; a malformed key or signature
  // can make verification throw, so treat any failure as an invalid signature.
  let signatureValid = false;
  try {
    const result = await wallet.verifySignature({
      data: serializeAuthSigData(proof.data),
      signature: proof.signature,
      protocolID: protocol,
      keyID: nonce,
      counterparty: identityKey,
    });
    signatureValid = result.valid;
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { valid: false, error: 'Invalid signature' };
  }

  const fresh = await deps.consumeNonce(nonce, new Date(expiresAt));
  if (!fresh) {
    return { valid: false, error: 'Proof already used' };
  }

  return { valid: true, identityKey };
}
