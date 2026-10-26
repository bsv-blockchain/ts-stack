import { toBase64 } from '@bsv/sdk/primitives/utils'
import { brc29ProtocolID } from '@bsv/wallet-toolbox-client'
import { Random, WalletInterface, PublicKey, WalletProtocol } from '@bsv/sdk'
export interface Derivation {
  protocolID: WalletProtocol
  keyID: string
}

export function getDerivation(): Derivation {
  const derivationPrefix = toBase64(Random(8))
  const derivationSuffix = toBase64(Random(8))
  return {
    protocolID: brc29ProtocolID,
    keyID: derivationPrefix + ' ' + derivationSuffix
  }
}

export interface AddressWithParams {
  address: string
  walletParams: {
    protocolID: WalletProtocol
    keyID: string
    counterparty: string
  }
}

const MAX_ADDRESS_BATCH = 1000

export async function getAddress(
  wallet: WalletInterface,
  amount: number = 1,
  counterparty: string = 'self'
): Promise<AddressWithParams[]> {
  if (!wallet) {
    throw new Error('Wallet is required')
  }
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_ADDRESS_BATCH) {
    throw new Error(`Amount must be a safe integer between 1 and ${MAX_ADDRESS_BATCH}`)
  }
  if (counterparty !== 'self' && counterparty !== 'anyone') {
    try {
      if (counterparty.length !== 66) throw new Error('not compressed')
      PublicKey.fromString(counterparty)
    } catch {
      throw new Error('counterparty must be "self", "anyone", or a compressed public key')
    }
  }

  try {
    // Generate all derivations and wallet calls in parallel for efficiency
    const addressPromises = Array.from({ length: amount }, async () => {
      const derivation = getDerivation()
      const { publicKey } = await wallet.getPublicKey({
        protocolID: derivation.protocolID,
        keyID: derivation.keyID,
        counterparty,
        forSelf: true
      })
      const address = PublicKey.fromString(publicKey).toAddress()
      return {
        address,
        walletParams: {
          protocolID: derivation.protocolID,
          keyID: derivation.keyID,
          counterparty
        }
      }
    })

    const addresses = await Promise.all(addressPromises)
    return addresses
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate addresses'
    throw new Error(message)
  }
}
