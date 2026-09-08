import { BEEF_V1, Beef, BeefTx, MerklePath, Script, Transaction, UnlockingScript } from '@bsv/sdk'
import { beefForTxids, pruneBeefForTxids } from '../beefForTxids'

describe('beefForTxids', () => {
  test('preserves the source wire version while removing unrelated transactions', () => {
    const required = makeTransaction(1000)
    const unrelated = makeTransaction(2000)
    const source = new Beef(BEEF_V1)
    source.mergeTransaction(required)
    source.mergeTransaction(unrelated)

    const result = beefForTxids(source, [required.id('hex')])

    expect(result.version).toBe(BEEF_V1)
    expect(Beef.fromBinary(result.toBinary()).version).toBe(BEEF_V1)
    expect(result.findTxid(required.id('hex'))).toBeDefined()
    expect(result.findTxid(unrelated.id('hex'))).toBeUndefined()
  })

  test('walks a deep dependency graph iteratively without indexed lookup churn', () => {
    const source = new Beef()
    const depth = 12000
    let previousTxid: string | undefined
    for (let index = 0; index < depth; index++) {
      const txid = index.toString(16).padStart(64, '0')
      const tx = BeefTx.fromTxid(txid)
      tx.inputTxids = previousTxid == null ? [] : [previousTxid]
      source.txs.push(tx)
      previousTxid = txid
    }
    source.txs.push(BeefTx.fromTxid('ff'.repeat(32)))
    const findTxid = jest.spyOn(source, 'findTxid')

    const result = beefForTxids(source, [previousTxid!])

    expect(result.txs).toHaveLength(depth)
    expect(findTxid).not.toHaveBeenCalled()
  })

  test('retains multi-level transaction ancestry and shared ancestors once', () => {
    const root = makeTransaction(1000)
    const parent = spend(root, 900)
    const child = spend(parent, 800)
    const source = new Beef()
    source.mergeTransaction(root)
    source.mergeTransaction(parent)
    source.mergeTransaction(child)
    source.mergeTransaction(makeTransaction(2000))

    const result = beefForTxids(source, [child.id('hex'), parent.id('hex')])

    expect(result.txs.map(tx => tx.txid)).toEqual([root.id('hex'), parent.id('hex'), child.id('hex')])
  })

  test('deep-copies selected transaction bytes and merkle paths', () => {
    const required = makeProvenTransaction(1000)
    const source = new Beef()
    source.mergeTransaction(required)
    source.mergeTransaction(makeTransaction(2000))

    const result = beefForTxids(source, [required.id('hex')])

    expect(result.bumps[0]).not.toBe(source.bumps[0])
    expect(result.bumps[0].path[0]).not.toBe(source.bumps[0].path[0])
    expect(result.txs[0].rawTxUint8Array).not.toBe(source.txs[0].rawTxUint8Array)
    result.bumps[0].path[0][0].hash = 'aa'.repeat(32)
    result.txs[0].rawTxUint8Array![0] ^= 0xff
    expect(source.bumps[0].path[0][0].hash).toBe(required.id('hex'))
    expect(source.txs[0].rawTxUint8Array![0]).not.toBe(result.txs[0].rawTxUint8Array![0])
  })

  test('reports the no-op case without rebuilding an equivalent BEEF', () => {
    const required = makeTransaction(1000)
    const source = new Beef()
    source.mergeTransaction(required)

    expect(pruneBeefForTxids(source, [required.id('hex')])).toBeUndefined()
    expect(beefForTxids(source, [required.id('hex')])).not.toBe(source)
  })
})

function makeTransaction(satoshis: number): Transaction {
  const transaction = new Transaction()
  transaction.addOutput({ satoshis, lockingScript: Script.fromHex('51') })
  return transaction
}

function spend(source: Transaction, satoshis: number): Transaction {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript()
  })
  transaction.addOutput({ satoshis, lockingScript: Script.fromHex('51') })
  return transaction
}

function makeProvenTransaction(satoshis: number): Transaction {
  const transaction = makeTransaction(satoshis)
  transaction.merklePath = new MerklePath(800000, [[{ offset: 0, hash: transaction.id('hex'), txid: true }]])
  return transaction
}
