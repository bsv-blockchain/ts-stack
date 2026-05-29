import {
  createAuthProof,
  createAuthSigData,
  serializeAuthSigData,
  checkAuthSigData,
  verifyAuthProof,
} from './core.js';
import type {
  AuthProof,
  AuthProofOptions,
  AuthSigData,
  ConsumeNonce,
  ProofSignerWallet,
  ProofVerifierWallet,
  VerifyAuthProofResult,
} from './types.js';

/**
 * Client-side toolkit. Construct once with the app's options (same `protocol`
 * the server uses), then mint proofs. Thin wrapper over the standalone functions.
 */
export class AuthProofClient {
  constructor(private readonly options: AuthProofOptions = {}) {}

  createAuthProof(wallet: ProofSignerWallet, backendPublicKey: string, action: string): Promise<AuthProof> {
    return createAuthProof(wallet, backendPublicKey, action, this.options);
  }

  createAuthSigData(action: string, identityKey: string, now?: number): AuthSigData {
    return createAuthSigData(action, identityKey, this.options, now);
  }

  serializeAuthSigData(data: AuthSigData): number[] {
    return serializeAuthSigData(data);
  }
}

/**
 * Server-side toolkit. Construct once with the app's options (same `protocol`
 * the client uses); pass your single-use store via `consumeNonce`. Thin wrapper
 * over the standalone functions.
 */
export class AuthProofServer {
  constructor(private readonly options: AuthProofOptions = {}) {}

  verifyAuthProof(
    wallet: ProofVerifierWallet,
    proof: AuthProof | undefined | null,
    expectedAction: string,
    deps: { consumeNonce: ConsumeNonce; now?: number },
  ): Promise<VerifyAuthProofResult> {
    return verifyAuthProof(wallet, proof, expectedAction, deps, this.options);
  }

  checkAuthSigData(
    data: AuthSigData | undefined | null,
    expectedAction: string,
    now: number,
  ): { valid: boolean; error?: string } {
    return checkAuthSigData(data, expectedAction, now, this.options);
  }

  serializeAuthSigData(data: AuthSigData): number[] {
    return serializeAuthSigData(data);
  }
}
