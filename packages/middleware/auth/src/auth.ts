import {
  createAuthProof,
  createAuthSigData,
  serializeAuthSigData,
  checkAuthSigData,
  verifyAuthProof
} from './core.js'
import type {
  AuthProof,
  AuthProofOptions,
  AuthSigData,
  ConsumeNonce,
  ProofSignerWallet,
  ProofVerifierWallet,
  RequestBody,
  VerifyAuthProofResult
} from './types.js'

/**
 * Client-side toolkit. Construct once with the app's options (same `protocol`
 * the server uses), then mint proofs. Thin wrapper over the standalone functions.
 */
export class AuthProofClient {
  constructor(private readonly options: AuthProofOptions = {}) {}

  createAuthProof(args: {
    wallet: ProofSignerWallet
    counterparty: string
    action: string
    body?: RequestBody
  }): Promise<AuthProof> {
    return createAuthProof({ ...args, ...this.options })
  }

  createAuthSigData(action: string, identityKey: string, now?: number): AuthSigData {
    return createAuthSigData(action, identityKey, this.options, now)
  }

  serializeAuthSigData(data: AuthSigData): number[] {
    return serializeAuthSigData(data)
  }
}

/**
 * Server-side toolkit. Construct once with the app's options (same `protocol`
 * the client uses); pass your single-use store via `consumeNonce`. Thin wrapper
 * over the standalone functions.
 */
export class AuthProofServer {
  constructor(private readonly options: AuthProofOptions = {}) {}

  verifyAuthProof(args: {
    wallet: ProofVerifierWallet
    proof: AuthProof | undefined | null
    action: string
    consumeNonce: ConsumeNonce
    now?: number
    body?: RequestBody
  }): Promise<VerifyAuthProofResult> {
    return verifyAuthProof({ ...args, ...this.options })
  }

  checkAuthSigData(
    data: AuthSigData | undefined | null,
    expectedAction: string,
    now: number
  ): { valid: boolean; error?: string } {
    return checkAuthSigData(data, expectedAction, now, this.options)
  }

  serializeAuthSigData(data: AuthSigData): number[] {
    return serializeAuthSigData(data)
  }
}
