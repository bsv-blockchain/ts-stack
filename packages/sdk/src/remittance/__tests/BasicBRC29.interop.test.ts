import { Brc29RemittanceModule } from '../modules/BasicBRC29.js'
import { ProtoWallet } from '../../wallet/ProtoWallet.js'
import type { WalletInterface } from '../../wallet/Wallet.interfaces.js'
import PrivateKey from '../../primitives/PrivateKey.js'
import PublicKey from '../../primitives/PublicKey.js'
import Transaction from '../../transaction/Transaction.js'
import Script from '../../script/Script.js'
import P2PKH from '../../script/templates/P2PKH.js'

const payerKey = new PrivateKey(71)
const recipientKey = new PrivateKey(72)
const payer = new ProtoWallet(payerKey)
const recipient = new ProtoWallet(recipientKey)
const protocolID: [2, string] = [2, '3241645161d8']
const prefix = 'cHJlZml4'
const suffix = 'c3VmZml4'

async function artifact(payToSender: boolean) {
  const key = await payer.getPublicKey({
    protocolID,
    keyID: `${prefix} ${suffix}`,
    counterparty: recipientKey.toPublicKey().toString(),
    forSelf: payToSender
  })
  const source = new Transaction()
  source.addOutput({ satoshis: 1000, lockingScript: Script.fromASM('OP_TRUE') })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  tx.addOutput({
    satoshis: 100,
    lockingScript: new P2PKH().lock(PublicKey.fromString(key.publicKey).toAddress())
  })
  return {
    customInstructions: { derivationPrefix: prefix, derivationSuffix: suffix },
    transaction: tx.toAtomicBEEF(),
    amountSatoshis: 100,
    outputIndex: 0
  }
}

describe('BRC-29 independent payer and recipient key derivation', () => {
  it.each([false, true])(
    'accepts only a recipient-spendable output; pays sender=%s',
    async paysSender => {
      const wallet = recipient as unknown as WalletInterface
      wallet.internalizeAction = jest.fn(async () => ({ accepted: true }))
      const result = await new Brc29RemittanceModule().acceptSettlement(
        {
          threadId: 'two-wallet-interop',
          sender: payerKey.toPublicKey().toString(),
          settlement: await artifact(paysSender)
        },
        { wallet, now: () => 1 }
      )
      expect(result.action).toBe(paysSender ? 'terminate' : 'accept')
      expect(wallet.internalizeAction).toHaveBeenCalledTimes(paysSender ? 0 : 1)
    }
  )
})
