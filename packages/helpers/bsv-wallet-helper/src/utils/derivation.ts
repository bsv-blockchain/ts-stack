import { brc29ProtocolID } from '@bsv/wallet-toolbox-client'
import { Random, Utils, WalletInterface, PublicKey, WalletProtocol } from '@bsv/sdk'

export function getDerivation() {
  const derivationPrefix = Utils.toBase64(Random(8))
  const derivationSuffix = Utils.toBase64(Random(8))
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

export async function getAddress(wallet: WalletInterface, amount: number = 1, counterparty: string = "self"): Promise<AddressWithParams[]> {
  if (!wallet) {
    throw new Error('Wallet is required')
  }
  if (amount < 1) {
    throw new Error('Amount must be greater than 0')
  }

  try {
    // Generate all derivations and wallet calls in parallel for efficiency
    const addressPromises = Array.from({ length: amount }, async () => {
      const derivation = getDerivation()
      const { publicKey } = await wallet.getPublicKey({
        protocolID: derivation.protocolID,
        keyID: derivation.keyID,
        counterparty
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