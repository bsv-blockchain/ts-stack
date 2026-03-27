import type { WalletProtocol, WalletInterface } from '@bsv/sdk'

// ── Wallet type ───────────────────────────────────────────────────────────────
// Minimal subset of @bsv/sdk's WalletInterface — satisfied by both ProtoWallet and WalletClient.
// We only need the three crypto primitives; no blockchain methods required.

export type WalletLike = Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>

// ── Protocol constant ─────────────────────────────────────────────────────────

export const PROTOCOL_ID: WalletProtocol = [0, 'mobile wallet session']

// ── Wire protocol ─────────────────────────────────────────────────────────────

/** Outer envelope routed by the relay — ciphertext is never decoded by the relay. */
export interface WireEnvelope {
  topic: string
  ciphertext: string          // base64url — output of wallet.encrypt
  mobileIdentityKey?: string  // only present on pairing_approved (bootstrap)
}

/** Inner RPC request (plaintext after decryption). */
export interface RpcRequest {
  id: string
  seq: number
  method: string
  params: unknown
}

/** Inner RPC response (plaintext after decryption). */
export interface RpcResponse {
  id: string
  seq: number
  result?: unknown
  error?: { code: number; message: string }
}

// ── Session ───────────────────────────────────────────────────────────────────

export type SessionStatus = 'pending' | 'connected' | 'disconnected' | 'expired'

export interface Session {
  id: string                  // also serves as topic and keyID
  status: SessionStatus
  createdAt: number
  expiresAt: number
  desktopToken: string        // random secret required for role=desktop WS connections
  mobileIdentityKey?: string  // set once on pairing_approved
  pairingStartedAt?: number   // set when mobile WS first connects; prevents race-expiry
}

export interface SessionInfo {
  sessionId: string
  status: SessionStatus
  qrDataUrl?: string
}

// ── Pairing URI ───────────────────────────────────────────────────────────────

/** Parameters encoded in a wallet://pair?… QR code. */
export interface PairingParams {
  topic: string
  relay: string
  backendIdentityKey: string
  protocolID: string  // JSON-encoded [number, string] tuple
  keyID: string       // must equal topic
  origin: string
  expiry: string      // Unix seconds
}

export type ParseResult =
  | { params: PairingParams; error: null }
  | { params: null; error: string }
