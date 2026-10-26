import {
  WalletInterface,
  WalletCounterparty,
  Base64String,
  OriginatorDomainNameStringUnder250Bytes
} from '../../wallet/Wallet.interfaces.js'
import { toBase64, toUTF8 } from '../../primitives/utils.js'
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
  const { hmac } = await wallet.createHmac(
    {
      protocolID: [2, 'server hmac'],
      keyID: toUTF8(firstHalf),
      data: firstHalf,
      counterparty
    },
    originator
  )
  if (!isExactBytes(hmac, 32)) {
    throw new Error('Wallet returned an invalid 32-byte nonce HMAC.')
  }
  // Concatenate firstHalf and secondHalf as the nonce bytes
  const nonceBytes = [...firstHalf, ...hmac]
  return toBase64(nonceBytes)
}

function isExactBytes(value: unknown, length: number): value is number[] {
  if (!Array.isArray(value) || value.length !== length) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor == null ||
      !Object.hasOwn(descriptor, 'value') ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      return false
    }
  }
  return true
}
