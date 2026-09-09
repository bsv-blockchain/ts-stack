import MerklePath from '../MerklePath'
import Transaction from '../Transaction'
import {
  assertEvidenceUnchanged,
  defaultTransactionEvidenceLimits,
  parseEvidence,
  TransactionEvidenceError
} from '../TransactionEvidence'
import P2PKH from '../../script/templates/P2PKH'
import PrivateKey from '../../primitives/PrivateKey'
import Script from '../../script/Script'

const height = 700_000

async function signedChild(): Promise<Transaction> {
  const key = new PrivateKey(46)
  const p2pkh = new P2PKH()
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 10, lockingScript: p2pkh.lock(key.toAddress()) })
  source.merklePath = new MerklePath(height, [
    [
      { offset: 0, hash: source.id('hex'), txid: true },
      { offset: 1, duplicate: true }
    ]
  ])
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: p2pkh.unlock(key)
  })
  tx.addOutput({ satoshis: 4, lockingScript: p2pkh.lock(key.toAddress()) })
  await tx.sign()
  return tx
}

function expectInvalid(evidence: { beef: number[]; outputIndex: number; txid?: string }): void {
  expect(() => parseEvidence(evidence, defaultTransactionEvidenceLimits)).toThrow(
    TransactionEvidenceError
  )
}

describe('parseEvidence', () => {
  it('rejects malformed snapshots before parsing', () => {
    expectInvalid({ beef: 'nope' as unknown as number[], outputIndex: 0 })
    expectInvalid({ beef: [], outputIndex: 0 })
    expectInvalid({ beef: [256], outputIndex: 0 })
    expectInvalid({ beef: [-1], outputIndex: 0 })
    expectInvalid({ beef: [1.5], outputIndex: 0 })
    expectInvalid({ beef: [1], outputIndex: -1 })
    expectInvalid({ beef: [1], outputIndex: 1.5 })
  })

  it('rejects an output index past the selected transaction', async () => {
    const tx = await signedChild()
    expectInvalid({ beef: tx.toBEEF(), outputIndex: tx.outputs.length })
  })

  it('rejects a mismatched source TXID and an unconfirmed zero-input leaf', async () => {
    const tx = await signedChild()
    tx.inputs[0].sourceTXID = '11'.repeat(32)
    expectInvalid({ beef: tx.toBEEF(), outputIndex: 0 })

    const leaf = new Transaction()
    leaf.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
    expectInvalid({ beef: leaf.toBEEF(), outputIndex: 0 })
  })

  it('walks a shared unconfirmed ancestor once and fences mutated owned bytes', async () => {
    const key = new PrivateKey(47)
    const p2pkh = new P2PKH()
    const confirmed = new Transaction()
    confirmed.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    confirmed.addOutput({ satoshis: 20, lockingScript: p2pkh.lock(key.toAddress()) })
    confirmed.merklePath = new MerklePath(height, [
      [
        { offset: 0, hash: confirmed.id('hex'), txid: true },
        { offset: 1, duplicate: true }
      ]
    ])
    const ancestor = new Transaction()
    ancestor.addInput({
      sourceTransaction: confirmed,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: p2pkh.unlock(key)
    })
    ancestor.addOutput({ satoshis: 9, lockingScript: p2pkh.lock(key.toAddress()) })
    ancestor.addOutput({ satoshis: 9, lockingScript: p2pkh.lock(key.toAddress()) })
    await ancestor.sign()
    const children: Transaction[] = []
    for (const outputIndex of [0, 1]) {
      const child = new Transaction()
      child.addInput({
        sourceTransaction: ancestor,
        sourceOutputIndex: outputIndex,
        unlockingScriptTemplate: p2pkh.unlock(key)
      })
      child.addOutput({ satoshis: 8, lockingScript: p2pkh.lock(key.toAddress()) })
      await child.sign()
      children.push(child)
    }
    const joined = new Transaction()
    for (const sourceTransaction of children) {
      joined.addInput({
        sourceTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: p2pkh.unlock(key)
      })
    }
    joined.addOutput({ satoshis: 15, lockingScript: p2pkh.lock(key.toAddress()) })
    await joined.sign()

    const candidate = parseEvidence(
      { beef: joined.toBEEF(), outputIndex: 0 },
      defaultTransactionEvidenceLimits
    )
    expect(candidate.txid).toBe(joined.id('hex'))
    candidate.tx.outputs[0].satoshis++
    expect(() => assertEvidenceUnchanged(candidate)).toThrow(TransactionEvidenceError)
  })
})
