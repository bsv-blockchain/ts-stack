import { Transaction, LockingScript, UnlockingScript, MerklePath } from '@bsv/sdk'
// Public structural BEEF only. Full Script/SPV premises are qualified by the native root host.
export function retainedBeefFixture(lockTime = 0) {
  const parent = new Transaction(
    1,
    [],
    [{ satoshis: 10, lockingScript: LockingScript.fromHex('51') }],
    lockTime
  )
  parent.merklePath = new MerklePath(101, [[{ offset: 0, hash: parent.id('hex'), txid: true }]])
  const child = new Transaction(
    1,
    [
      {
        sourceTransaction: parent,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: new UnlockingScript()
      }
    ],
    [{ satoshis: 9, lockingScript: LockingScript.fromHex('51') }],
    lockTime
  )
  const txid = child.id('hex'),
    bytes = child.toAtomicBEEF(),
    raw = Transaction.fromBinary(child.toBinary())
  return { parent, child, txid, bytes, raw }
}
