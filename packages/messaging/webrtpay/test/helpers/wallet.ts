import { jest } from '@jest/globals'
import { PrivateKey, ProtoWallet, PublicKey } from '@bsv/sdk'
import { PAYMENT_PROTOCOL_ID } from '../../src/types.js'
import type { PaymentToken, WalletLike } from '../../src/types.js'
import { randomBytes, toBase64 } from '../../src/util/bytes.js'
import { makePaymentTx } from './tx.js'

export interface TestWallet {
  wallet: WalletLike
  identityKey: string
  internalizeAction: ReturnType<typeof jest.fn<WalletLike['internalizeAction']>>
}

/** A ProtoWallet (real keys, signatures and encryption) with a jest-mocked internalizeAction. */
export async function makeWallet(): Promise<TestWallet> {
  const internalizeAction = jest.fn<WalletLike['internalizeAction']>(() =>
    Promise.resolve({ accepted: true })
  )
  const wallet: WalletLike = Object.assign(new ProtoWallet(PrivateKey.fromRandom()), {
    internalizeAction
  })
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return { wallet, identityKey: publicKey, internalizeAction }
}

/** A payer-built token paying `satoshis` to the payee's BRC-29 derived key at output 0. */
export async function makeToken(
  payer: TestWallet,
  payeeKey: string,
  satoshis: number,
  padBytes?: number
): Promise<{ token: PaymentToken; txid: string }> {
  const derivationPrefix = toBase64(randomBytes(32))
  const derivationSuffix = toBase64(randomBytes(32))
  const { publicKey } = await payer.wallet.getPublicKey({
    protocolID: PAYMENT_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: payeeKey
  })
  const { beef, txid } = makePaymentTx(PublicKey.fromString(publicKey), satoshis, { padBytes })
  return {
    token: {
      customInstructions: { derivationPrefix, derivationSuffix },
      transaction: beef,
      amount: satoshis,
      outputIndex: 0
    },
    txid
  }
}
