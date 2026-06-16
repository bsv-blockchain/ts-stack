// Standalone functions — the base API.
export {
  serializeAuthSigData,
  serializeSignablePayload,
  normalizeBody,
  createAuthSigData,
  checkAuthSigData,
  createAuthProof,
  verifyAuthProof,
} from './core.js';

// Ergonomic class wrappers — construct once with options, then call methods.
export { AuthProofClient, AuthProofServer } from './auth.js';

export { DEFAULT_PROTOCOL, DEFAULT_WINDOW_MS, DEFAULT_CLOCK_SKEW_MS } from './constants.js';

export type {
  AuthProof,
  AuthSigData,
  RequestBody,
  CreateAuthProofArgs,
  VerifyAuthProofArgs,
  VerifyAuthProofResult,
  ConsumeNonce,
  AuthProofOptions,
  ProofSignerWallet,
  ProofVerifierWallet,
} from './types.js';
