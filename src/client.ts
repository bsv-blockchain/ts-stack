// ── Client entry ─────────────────────────────────────────────────────────────
// Browser + React Native. No Node.js dependencies.

export {
  WalletPairingSession,
  DEFAULT_IMPLEMENTED_METHODS,
  DEFAULT_AUTO_APPROVE_METHODS,
} from './client/WalletPairingSession.js'
export type {
  PairingSessionStatus,
  RequestHandler,
  WalletPairingSessionOptions,
} from './client/WalletPairingSession.js'

// ── Shared utilities ──────────────────────────────────────────────────────────

export { parsePairingUri } from './shared/pairingUri.js'
export { encryptEnvelope, decryptEnvelope } from './shared/crypto.js'
export { bytesToBase64url, base64urlToBytes } from './shared/encoding.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export { PROTOCOL_ID } from './types.js'
export type {
  WalletLike,
  WireEnvelope,
  RpcRequest,
  RpcResponse,
  SessionInfo,
  SessionStatus,
  PairingParams,
  ParseResult,
} from './types.js'
export type { CryptoParams } from './shared/crypto.js'
