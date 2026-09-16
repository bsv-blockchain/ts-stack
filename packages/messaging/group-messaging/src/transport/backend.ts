import type { IdentityKey, MlsGroupId, Unsubscribe, WirePayload } from '../types.js'

/**
 * The delivery seam: get these bytes to that identity, and tell me when bytes
 * arrive for me.
 *
 * Payloads are opaque. A transport never sees plaintext and does not need to
 * understand MLS framing, which is what lets the same group logic run over
 * MessageBox, WebRTC, libp2p or a native bridge.
 */
export interface TransportBackend {
  send(recipient: IdentityKey, payload: WirePayload): Promise<void>

  /**
   * Optional bulk delivery. When a backend implements it, {@link TransportService}
   * uses it for Commits and application messages instead of N single sends.
   */
  broadcast?(groupId: MlsGroupId, recipients: IdentityKey[], payload: WirePayload): Promise<void>

  onMessage(handler: (from: IdentityKey, payload: Uint8Array) => void | Promise<void>): Unsubscribe

  /**
   * The backend's own failures — a poll that returned 401, a socket that
   * dropped, an expired token — as opposed to a handler that threw. Without
   * this they have nowhere to go but an unhandled rejection inside a timer.
   */
  onError?(handler: (error: Error) => void): Unsubscribe

  start?(): Promise<void>
  close?(): Promise<void>
}
