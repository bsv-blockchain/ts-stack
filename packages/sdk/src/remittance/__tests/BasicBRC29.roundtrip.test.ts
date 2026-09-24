import Script from '../../script/Script.js'
import Transaction from '../../transaction/Transaction.js'
import PrivateKey from '../../primitives/PrivateKey.js'
import ProtoWallet from '../../wallet/ProtoWallet.js'
import type {
  CreateActionArgs,
  GetPublicKeyArgs,
  InternalizeActionArgs,
  WalletInterface
} from '../../wallet/Wallet.interfaces.js'
import { Brc29RemittanceModule } from '../modules/BasicBRC29.js'
import type { ModuleContext } from '../types.js'

// Uses real ProtoWallet key derivation on both sides (no getPublicKey mocks) so
// that sender/recipient BRC-42 asymmetry (forSelf) is actually exercised.

class SenderWallet {
  readonly proto: ProtoWallet
  pending?: Transaction

  constructor (key: PrivateKey) {
    this.proto = new ProtoWallet(key)
  }

  async getPublicKey (args: GetPublicKeyArgs) {
    return await this.proto.getPublicKey(args)
  }

  async createAction (args: CreateActionArgs) {
    this.pending = new Transaction(args.version ?? 1, [], [], args.lockTime ?? 0)
    const source = new Transaction()
    source.addOutput({ satoshis: 1_000_000, lockingScript: Script.fromASM('OP_1') })
    this.pending.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_1')
    })
    for (const output of args.outputs ?? []) {
      this.pending.addOutput({
        satoshis: output.satoshis,
        lockingScript: Script.fromHex(output.lockingScript)
      })
    }
    return {
      signableTransaction: {
        reference: 'YnJjMjktcm91bmR0cmlw',
        tx: this.pending.toAtomicBEEF(true)
      }
    }
  }

  async signAction () {
    if (this.pending == null) throw new Error('missing pending transaction')
    return { tx: this.pending.toAtomicBEEF(true), txid: this.pending.id('hex') }
  }

  async abortAction () {
    return { aborted: true }
  }
}

class RecipientWallet {
  readonly proto: ProtoWallet
  readonly internalizeAction = jest.fn(async (_args: InternalizeActionArgs) => ({ accepted: true }))

  constructor (key: PrivateKey) {
    this.proto = new ProtoWallet(key)
  }

  async getPublicKey (args: GetPublicKeyArgs) {
    return await this.proto.getPublicKey(args)
  }
}

function ctx (wallet: unknown): ModuleContext {
  return { wallet: wallet as WalletInterface, originator: 'example.com', now: () => 1 }
}

function brc29 (): Brc29RemittanceModule {
  let nonce = 0
  return new Brc29RemittanceModule({
    nonceProvider: { createNonce: async () => `nonce-${++nonce}` }
  })
}

describe('Brc29RemittanceModule sender/recipient round trip', () => {
  const senderKey = new PrivateKey(11)
  const recipientKey = new PrivateKey(22)
  const sender = senderKey.toPublicKey().toString()
  const payee = recipientKey.toPublicKey().toString()

  it('recipient accepts a settlement built for it by a real sender wallet', async () => {
    const module = brc29()
    const senderWallet = new SenderWallet(senderKey)
    const recipientWallet = new RecipientWallet(recipientKey)

    const built = await module.buildSettlement(
      { threadId: 'thread-1', option: { amountSatoshis: 1000, payee } },
      ctx(senderWallet)
    )
    expect(built.action).toBe('settle')
    if (built.action !== 'settle') return

    const accepted = await module.acceptSettlement(
      { threadId: 'thread-1', settlement: built.artifact, sender },
      ctx(recipientWallet)
    )
    expect(accepted).toEqual({
      action: 'accept',
      receiptData: { internalizeResult: { accepted: true } }
    })
    expect(recipientWallet.internalizeAction).toHaveBeenCalledTimes(1)
    const request = recipientWallet.internalizeAction.mock.calls[0][0]
    expect(request.outputs[0].paymentRemittance?.senderIdentityKey).toBe(sender)
  })

  it('a third party cannot accept a settlement addressed to someone else', async () => {
    const module = brc29()
    const senderWallet = new SenderWallet(senderKey)
    const intruderWallet = new RecipientWallet(new PrivateKey(33))

    const built = await module.buildSettlement(
      { threadId: 'thread-2', option: { amountSatoshis: 1000, payee } },
      ctx(senderWallet)
    )
    if (built.action !== 'settle') throw new Error('expected settle')

    const accepted = await module.acceptSettlement(
      { threadId: 'thread-2', settlement: built.artifact, sender },
      ctx(intruderWallet)
    )
    expect(accepted.action).toBe('terminate')
    expect(intruderWallet.internalizeAction).not.toHaveBeenCalled()
  })
})
