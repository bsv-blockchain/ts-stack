import {
  Beef,
  CompletedProtoWallet,
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  Script,
  Transaction,
  type CreateActionArgs,
  type CreateActionResult,
  type InternalizeActionArgs,
  type InternalizeActionResult
} from '@bsv/sdk'

/** A paying wallet: real key derivation, and `createAction` that builds a real Atomic BEEF. */
export class PayerWallet extends CompletedProtoWallet {
  readonly identityKey: string
  readonly actions: CreateActionArgs[] = []
  failCreateAction = false

  constructor(key: PrivateKey = PrivateKey.fromRandom()) {
    super(key)
    this.identityKey = key.toPublicKey().toString()
  }

  override async createAction(args?: CreateActionArgs): Promise<CreateActionResult> {
    if (this.failCreateAction) throw new Error('Insufficient funds')
    if (args === undefined) throw new Error('createAction requires args')
    this.actions.push(args)
    const transaction = new Transaction()
    transaction.addInput({
      sourceTXID: '0'.repeat(64),
      sourceOutputIndex: 0xffffffff,
      unlockingScript: Script.fromHex('00'),
      sequence: 0xffffffff
    })
    for (const output of args.outputs ?? []) {
      transaction.addOutput({
        lockingScript: LockingScript.fromHex(output.lockingScript),
        satoshis: output.satoshis
      })
    }
    const txid = transaction.id('hex')
    const beef = new Beef()
    beef.mergeTransaction(transaction)
    return { txid, tx: beef.toBinaryAtomic(txid) }
  }
}

/** A host wallet whose `internalizeAction` checks the BRC-29 script exactly as wallet-toolbox does. */
export class HostWallet extends CompletedProtoWallet {
  readonly identityKey: string
  readonly internalized: Array<{
    txid: string
    outputIndex: number
    satoshis: number
    sender: string
  }> = []
  rejectPayments = false

  constructor(key: PrivateKey = PrivateKey.fromRandom()) {
    super(key)
    this.identityKey = key.toPublicKey().toString()
  }

  override async internalizeAction(args?: InternalizeActionArgs): Promise<InternalizeActionResult> {
    if (this.rejectPayments) throw new Error('Payment rejected')
    if (args === undefined) throw new Error('internalizeAction requires args')
    const transaction = Transaction.fromAtomicBEEF(args.tx)
    for (const entry of args.outputs) {
      const remittance = entry.paymentRemittance
      if (entry.protocol !== 'wallet payment' || remittance === undefined) {
        throw new Error('Only wallet payments are supported')
      }
      const { publicKey } = await this.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${remittance.derivationPrefix} ${remittance.derivationSuffix}`,
        counterparty: remittance.senderIdentityKey,
        forSelf: true
      })
      const expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
      const output = transaction.outputs[entry.outputIndex]
      if (output === undefined || output.lockingScript.toHex() !== expected) {
        throw new Error('Output is not locked by a script conforming to BRC-29')
      }
      this.internalized.push({
        txid: transaction.id('hex'),
        outputIndex: entry.outputIndex,
        satoshis: output.satoshis ?? 0,
        sender: remittance.senderIdentityKey
      })
    }
    return { accepted: true }
  }
}
