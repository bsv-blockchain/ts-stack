import {
  WalletInterface,
  WalletCounterparty,
  Base64String,
  OriginatorDomainNameStringUnder250Bytes
} from '../../wallet/Wallet.interfaces.js'
import * as Utils from '../../primitives/utils.js'
import Random from '../../primitives/Random.js'

/**
 * Creates a wallet-authenticated challenge token.
 *
 * Despite the historical name, this value has no expiry and is not single-use
 * by itself. Do not use it as a standalone login or replay-prevention token.
 * Authentication flows must bind the challenge to a signature and track
 * freshness, as BRC-103 `Peer` does.
 * @param wallet
 * @param counterparty - The counterparty to the nonce creation. Defaults to 'self'.
 * @returns A random nonce derived with a wallet
 */
export async function createNonce(
  wallet: WalletInterface,
  counterparty: WalletCounterparty = 'self',
  originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<Base64String> {
  // Generate 16 random bytes for the first half of the data
  const firstHalf = Random(16)
  // Create an sha256 HMAC
  const { hmac } = await wallet.createHmac({
    protocolID: [2, 'server hmac'],
    keyID: Utils.toUTF8(firstHalf),
    data: firstHalf,
    counterparty
  }, originator)
  // Concatenate firstHalf and secondHalf as the nonce bytes
  const nonceBytes = [...firstHalf, ...hmac]
  return Utils.toBase64(nonceBytes)
}
