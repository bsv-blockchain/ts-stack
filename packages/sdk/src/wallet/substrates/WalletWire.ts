/**
 * A Wallet Wire is an abstraction over a raw transport medium where binary data can be sent to and subsequently received from a wallet.
 *
 * Implementations are an untrusted boundary. Requests and responses must be
 * dense byte data no larger than {@link MAX_WALLET_WIRE_FRAME_BYTES}; the
 * processor validates decoded BRC-100 arguments before wallet dispatch and the
 * transceiver validates returned results before exposing them to callers.
 */
export const MAX_WALLET_WIRE_FRAME_BYTES = 256 * 1024 * 1024

export default interface WalletWire {
  transmitToWallet: (message: number[]) => Promise<number[]>
  /**
   * Optional compact-byte transport. Implementations can provide this lane to
   * avoid boxing multi-megabyte wire frames while the legacy method remains
   * available for backwards compatibility.
   */
  transmitToWalletUint8Array?: (message: Uint8Array) => Promise<Uint8Array>
}
