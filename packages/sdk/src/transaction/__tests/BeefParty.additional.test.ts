import BeefParty from '../BeefParty'
import { Beef } from '../Beef'
import Transaction from '../Transaction'
import MerklePath from '../MerklePath'
import Script from '../../script/Script'

function provenTransaction(index: number): Transaction {
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromASM(`OP_${(index % 16) + 1}`)
  })
  tx.addOutput({ satoshis: index + 1, lockingScript: Script.fromASM('OP_TRUE') })
  const txid = tx.id('hex')
  tx.merklePath = new MerklePath(800_000 + index, [[{ offset: 0, hash: txid, txid: true }]])
  return tx
}

describe('BeefParty – additional coverage', () => {
  describe('mergeBeefFromParty', () => {
    it('merges a Beef object directly (non-array branch)', () => {
      const bp = new BeefParty(['alice'])
      const b = new Beef()
      bp.mergeBeefFromParty('alice', b)
      // No error thrown means the Beef object branch executed
      expect(bp.isParty('alice')).toBe(true)
    })

    it('merges a binary Beef (array branch) via Beef.fromBinary', () => {
      const bp = new BeefParty(['bob'])
      const emptyBeef = new Beef()
      const binary = emptyBeef.toBinary()
      bp.mergeBeefFromParty('bob', binary)
      expect(bp.isParty('bob')).toBe(true)
    })

    it('synchronizes once for a bulk party merge and records known txids directly', () => {
      const incoming = new Beef()
      for (let index = 0; index < 64; index++) incoming.mergeTransaction(provenTransaction(index))
      expect(incoming.getValidTxids()).toHaveLength(64)

      const receiver = new BeefParty(['storage'])
      const synchronize = jest.spyOn(receiver as any, 'synchronizeNestedTransactionMutations')
      receiver.mergeBeefFromParty('storage', incoming)

      expect(synchronize).toHaveBeenCalledTimes(1)
      expect(receiver.txs).toHaveLength(64)
      expect(receiver.getKnownTxidsForParty('storage')).toHaveLength(64)
      expect(receiver.isValid()).toBe(true)
    })
  })
})
