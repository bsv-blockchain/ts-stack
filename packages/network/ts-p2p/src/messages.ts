/**
 * Teranode P2P message types and decoder.
 *
 * Messages arrive on the GossipSub wire in a two-layer JSON format:
 *
 *   Layer 1 (Message Bus Envelope):
 *     { "name": "<sender>", "data": "<base64-encoded inner JSON>" }
 *
 *   Layer 2 (Topic Payload):
 *     JSON object whose schema depends on the topic.
 *
 * The envelope format comes from go-p2p-message-bus (client.go).
 * The payload schemas come from teranode/services/p2p (message_types.go).
 *
 * Key quirk: block/subtree/rejected-tx use PascalCase keys (no Go json tags),
 * while node_status uses snake_case keys (explicit Go json tags).
 */

// ---------------------------------------------------------------------------
// Message Bus Envelope (Layer 1)
// ---------------------------------------------------------------------------

/** Outer envelope wrapping every GossipSub message. */
export interface MessageEnvelope {
  /** Sender node name (e.g. "GorillaPool-mainnet-1"). */
  name: string
  /** Base64-encoded inner JSON payload. */
  data: string
}

// ---------------------------------------------------------------------------
// Topic Payloads (Layer 2) — PascalCase topics
// ---------------------------------------------------------------------------

/** Block announcement from a miner. */
export interface BlockMessage {
  PeerID: string
  ClientName: string
  DataHubURL: string
  Hash: string
  Height: number
  Header: string
  Coinbase: string
}

/** Subtree (transaction batch) from a miner. */
export interface SubtreeMessage {
  PeerID: string
  ClientName: string
  DataHubURL: string
  Hash: string
}

/** Rejected transaction notification. */
export interface RejectedTxMessage {
  PeerID: string
  ClientName: string
  TxID: string
  Reason: string
}

// ---------------------------------------------------------------------------
// Fee policy (carried inside node_status; snake_case via Go json tags)
// ---------------------------------------------------------------------------

/** A fee rate expressed as satoshis per number of bytes. */
export interface FeeAmount {
  satoshis: number
  bytes: number
}

/** Full fee policy a node advertises to peers. */
export interface FeePolicy {
  miningFee: FeeAmount
  maxscriptsizepolicy: number
  maxtxsizepolicy: number
  maxtxsigopscountspolicy: number
}

// ---------------------------------------------------------------------------
// Topic Payload — snake_case (node_status has explicit Go json tags)
// ---------------------------------------------------------------------------

/** Node status broadcast from a Teranode peer. */
export interface NodeStatusMessage {
  peer_id: string
  client_name: string
  type: string
  base_url: string
  propagation_url?: string
  version: string
  commit_hash: string
  best_block_hash: string
  best_height: number
  tx_count?: number
  subtree_count?: number
  fsm_state: string
  start_time: number
  uptime: number
  miner_name: string
  listen_mode: string
  chain_work: string
  sync_peer_id?: string
  sync_peer_height?: number
  sync_peer_block_hash?: string
  sync_connected_at?: number
  min_mining_tx_fee?: number | null
  /** Full fee policy advertised to peers (omitted by older peers). */
  fee_policy?: FeePolicy
  connected_peers_count?: number
  storage?: string
}

// ---------------------------------------------------------------------------
// Union type for any decoded message
// ---------------------------------------------------------------------------

export type TeranodeMessage = BlockMessage | SubtreeMessage | RejectedTxMessage | NodeStatusMessage

// ---------------------------------------------------------------------------
// Decoded result (envelope + typed payload)
// ---------------------------------------------------------------------------

/** Fully decoded message: envelope metadata + typed inner payload. */
export interface DecodedMessage<T = TeranodeMessage> {
  /** Sender node name from the envelope. */
  sender: string
  /** Decoded inner payload, typed per topic. */
  payload: T
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Decode a raw GossipSub message (Uint8Array) into a typed object.
 *
 * Two-layer decode:
 *   1. UTF-8 decode bytes -> JSON.parse -> MessageEnvelope { name, data }
 *   2. Base64 decode envelope.data -> JSON.parse -> topic-specific payload
 *
 * @param data - Raw bytes from the GossipSub callback
 * @returns DecodedMessage with sender name and typed payload
 * @throws If the bytes are not valid two-layer JSON
 */
export function decodeMessage<T = TeranodeMessage>(data: Uint8Array): DecodedMessage<T> {
  const text = decoder.decode(data)
  const envelope: unknown = JSON.parse(text)
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    typeof (envelope as Record<string, unknown>).name !== 'string' ||
    typeof (envelope as Record<string, unknown>).data !== 'string'
  ) {
    throw new TypeError('Invalid message envelope')
  }

  // Decode the base64 inner payload
  const innerBytes = base64ToBytes((envelope as MessageEnvelope).data)
  const innerText = decoder.decode(innerBytes)
  const payload: unknown = JSON.parse(innerText)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Invalid message payload')
  }

  return { sender: (envelope as MessageEnvelope).name, payload: payload as T }
}

/**
 * Try to decode a message, returning null on failure instead of throwing.
 * Useful for high-volume topics (subtrees) where parse failures shouldn't crash,
 * and for skipping non-JSON frames such as libp2p discovery probes.
 */
export function tryDecodeMessage<T = TeranodeMessage>(data: Uint8Array): DecodedMessage<T> | null {
  try {
    return decodeMessage<T>(data)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers (no Node.js dependency — works in any JS runtime)
// ---------------------------------------------------------------------------

/** Standard base64 alphabet lookup table, built once. */
const B64: Record<string, number> = {}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (let i = 0; i < alphabet.length; i++) B64[alphabet[i]] = i

/** Decode a base64 string to Uint8Array without depending on Buffer or atob. */
function base64ToBytes(b64: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64) ||
    b64.length === 0
  ) {
    throw new TypeError('Invalid canonical base64 payload')
  }
  if (
    (b64.endsWith('==') && (B64[b64.at(-3)!] & 0x0f) !== 0) ||
    (!b64.endsWith('==') && b64.endsWith('=') && (B64[b64.at(-2)!] & 0x03) !== 0)
  ) {
    throw new TypeError('Invalid canonical base64 payload')
  }

  // Strip trailing '=' padding (plain scan, no backtracking-prone regex)
  let end = b64.length
  while (end > 0 && b64[end - 1] === '=') end--
  const clean = b64.slice(0, end)
  const len = (clean.length * 3) >>> 2
  const out = new Uint8Array(len)
  let pos = 0

  for (let i = 0; i < clean.length; i += 4) {
    // Canonical base64 always has at least two symbols in its final quantum.
    const a = B64[clean[i]]
    const b = B64[clean[i + 1]]
    const c = B64[clean[i + 2]] ?? 0
    const d = B64[clean[i + 3]] ?? 0
    const bits = (a << 18) | (b << 12) | (c << 6) | d
    if (pos < len) out[pos++] = (bits >>> 16) & 0xff
    if (pos < len) out[pos++] = (bits >>> 8) & 0xff
    if (pos < len) out[pos++] = bits & 0xff
  }

  return out
}
