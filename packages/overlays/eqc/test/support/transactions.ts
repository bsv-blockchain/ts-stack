import { Beef, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'

/** A one-output transaction wrapped in BEEF, for building lookup answers in tests. */
export function sampleBeef(satoshis: number): { beef: number[]; txid: string } {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '0'.repeat(64),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  transaction.addOutput({
    lockingScript: new P2PKH().lock(new PrivateKey(2).toPublicKey().toAddress()),
    satoshis
  })
  const txid = transaction.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return { beef: beef.toBinary(), txid }
}
