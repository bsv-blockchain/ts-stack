import { Beef, LockingScript, MerklePath, Transaction, UnlockingScript } from '@bsv/sdk'
import { Engine } from '../Engine'
import type { Output } from '../Output'
import type { Storage } from '../storage/Storage'

function confirmed(version: number, predecessor?: Transaction): Transaction {
  const tx = new Transaction(
    1,
    [],
    [{ satoshis: 1, lockingScript: LockingScript.fromHex('51') }],
    version
  )
  if (predecessor != null) {
    tx.addInput({
      sourceTXID: predecessor.id('hex'),
      sourceOutputIndex: 0,
      sequence: 0xffffffff,
      unlockingScript: UnlockingScript.fromHex('')
    })
  }
  tx.merklePath = new MerklePath(100 + version, [[{ offset: 0, hash: tx.id('hex'), txid: true }]])
  return tx
}

function output(tx: Transaction, predecessor?: Transaction): Output {
  return {
    txid: tx.id('hex'),
    outputIndex: 0,
    outputScript: tx.outputs[0].lockingScript.toBinary(),
    satoshis: 1,
    topic: 'tm_users',
    spent: false,
    outputsConsumed: predecessor == null ? [] : [{ txid: predecessor.id('hex'), outputIndex: 0 }],
    consumedBy: [],
    beef: tx.toBEEF()
  }
}

describe('Explicit lookup history across confirmation', () => {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => 103 }

  function fixture() {
    const old = confirmed(1)
    const middle = confirmed(2, old)
    const current = confirmed(3, middle)
    const records = [output(old), output(middle, old), output(current, middle)]
    const storage = {
      findOutput: jest.fn(async (txid: string) => records.find(row => row.txid === txid) ?? null)
    } as unknown as Storage
    return { old, middle, current, records, engine: new Engine({}, {}, storage, chainTracker) }
  }

  it('retains selected confirmed predecessors and keeps the current subject last', async () => {
    const { old, middle, current, records, engine } = fixture()
    const original = records.map(row => row.beef?.slice())
    const decider = jest.fn(async () => true)
    const result = await engine.getUTXOHistory(records[2], decider, 0)
    expect(result?.beef).toBeDefined()
    const beef = Beef.fromBinary(result!.beef!)
    expect(new Set(beef.txs.map(tx => tx.txid))).toEqual(
      new Set([old.id('hex'), middle.id('hex'), current.id('hex')])
    )
    expect(Transaction.fromBEEF(result!.beef!).id('hex')).toBe(current.id('hex'))
    for (const tx of [old, middle, current]) {
      expect(beef.findAtomicTransaction(tx.id('hex'))?.merklePath?.blockHeight).toBe(
        tx.merklePath?.blockHeight
      )
    }
    expect(decider.mock.calls).toEqual([
      [original[2], 0, 0],
      [original[1], 0, 1],
      [original[0], 0, 2]
    ])
    expect(records.map(row => row.beef)).toEqual(original)
  })

  it('honors a decider cutoff without adding the unselected confirmed ancestor', async () => {
    const { old, middle, current, records, engine } = fixture()
    const result = await engine.getUTXOHistory(
      records[2],
      async (_beef, _index, depth) => depth < 2,
      0
    )
    const beef = Beef.fromBinary(result!.beef!)
    expect(new Set(beef.txs.map(tx => tx.txid))).toEqual(
      new Set([middle.id('hex'), current.id('hex')])
    )
    expect(beef.findTxid(old.id('hex'))).toBeUndefined()
    expect(Transaction.fromBEEF(result!.beef!).id('hex')).toBe(current.id('hex'))
  })

  it('preserves numeric history selection across the proof boundary', async () => {
    const { middle, current, records, engine } = fixture()
    const result = await engine.getUTXOHistory(records[2], 1, 0)
    expect(
      Beef.fromBinary(result!.beef!)
        .txs.map(tx => tx.txid)
        .sort()
    ).toEqual([middle.id('hex'), current.id('hex')].sort())
  })

  it('returns the original output and bytes when history is not requested', async () => {
    const { records, engine } = fixture()
    await expect(engine.getUTXOHistory(records[2])).resolves.toBe(records[2])
    expect(engine.storage.findOutput).not.toHaveBeenCalled()
  })
})
