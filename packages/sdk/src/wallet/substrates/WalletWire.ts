/**
 * A Wallet Wire is an abstraction over a raw transport medium where binary data can be sent to and subsequently received from a wallet.
 */
export default interface WalletWire {
  transmitToWallet: (message: number[]) => Promise<number[]>
  /**
   * Optional compact-byte transport. Implementations can provide this lane to
   * avoid boxing multi-megabyte wire frames while the legacy method remains
   * available for backwards compatibility.
   */
  transmitToWalletUint8Array?: (message: Uint8Array) => Promise<Uint8Array>
}
