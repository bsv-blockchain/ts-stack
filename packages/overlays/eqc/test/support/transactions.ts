import {
  Beef,
  OverlayAdminTokenTemplate,
  P2PKH,
  PrivateKey,
  PushDrop,
  Script,
  Transaction,
  Utils,
  type LockingScript,
  type WalletInterface
} from '@bsv/sdk'

function wrap(lockingScript: LockingScript, satoshis: number): { beef: number[]; txid: string } {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '0'.repeat(64),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  transaction.addOutput({ lockingScript, satoshis })
  const txid = transaction.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return { beef: beef.toBinary(), txid }
}

/** A one-output transaction wrapped in BEEF, for building lookup answers in tests. */
export function sampleBeef(satoshis: number): { beef: number[]; txid: string } {
  return wrap(new P2PKH().lock(new PrivateKey(2).toPublicKey().toAddress()), satoshis)
}

/** A real SHIP/SLAP advertisement token, as a SLAP tracker would return it. */
export async function slapTokenOutput(
  wallet: WalletInterface,
  domain: string,
  service: string,
  protocol: 'SHIP' | 'SLAP' = 'SLAP'
): Promise<{ beef: number[]; outputIndex: number }> {
  const script = await new OverlayAdminTokenTemplate(wallet).lock(protocol, domain, service)
  return { beef: wrap(script, 1).beef, outputIndex: 0 }
}

/** A real `tm_messagebox` advertisement: PushDrop fields `[identityKey, host]`. */
export async function messageBoxTokenOutput(
  wallet: WalletInterface,
  recipient: string,
  host: string
): Promise<{ beef: number[]; outputIndex: number }> {
  const script = await new PushDrop(wallet).lock(
    [Utils.toArray(recipient, 'hex'), Utils.toArray(host, 'utf8')],
    [1, 'messagebox advertisement'],
    '1',
    'anyone',
    true
  )
  return { beef: wrap(script, 1).beef, outputIndex: 0 }
}
