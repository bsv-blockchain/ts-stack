// ── Server entry ─────────────────────────────────────────────────────────────
// Node.js only. Requires: ws, qrcode, express (peer dependencies).

export { WebSocketRelay } from './server/WebSocketRelay.js'
export { QRSessionManager } from './server/QRSessionManager.js'
export type { QRSessionManagerOptions } from './server/QRSessionManager.js'
export { WalletRequestHandler } from './server/WalletRequestHandler.js'
export { WalletRelayService } from './server/WalletRelayService.js'
export type { WalletRelayServiceOptions } from './server/WalletRelayService.js'
export type {
  Role,
  MessageHandler,
  TopicValidator,
  TokenValidator,
  ConnectHandler,
  DisconnectHandler,
} from './server/WebSocketRelay.js'

// ── Shared utilities (also available from ./client) ───────────────────────────

export { parsePairingUri, buildPairingUri, verifyPairingSignature, DEFAULT_ACCEPTED_SCHEMAS } from './shared/pairingUri.js'
export { encryptEnvelope, decryptEnvelope } from './shared/crypto.js'
export { bytesToBase64url, base64urlToBytes } from './shared/encoding.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export { PROTOCOL_ID } from './types.js'
export type {
  WalletLike,
  WireEnvelope,
  RpcRequest,
  RpcResponse,
  Session,
  SessionInfo,
  SessionStatus,
  PairingParams,
  ParseResult,
} from './types.js'
export type { CryptoParams } from './shared/crypto.js'
