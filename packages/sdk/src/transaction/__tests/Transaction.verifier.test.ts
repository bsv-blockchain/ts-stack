import Transaction from '../Transaction'
import Script from '../../script/Script'
import P2PKH from '../../script/templates/P2PKH'
import PrivateKey from '../../primitives/PrivateKey'
import MerklePath from '../MerklePath'
import type BdkVerifierInterface from '../BdkVerifierInterface'

// Build a tx whose single P2PKH input is genuinely valid under the pure-JS interpreter.
async function buildValidTx (): Promise<Transaction> {
  const key = PrivateKey.fromRandom()
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  await source.sign()
  source.merklePath = new MerklePath(1000, [
    [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key)
  })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

describe('Transaction.verify with a pluggable verifier', () => {
  it('routes to the verifier and returns its false result, bypassing Spend', async () => {
    const tx = await buildValidTx()
    let called = 0
    const verifier: BdkVerifierInterface = {
      verifyScripts: async () => { called++; return false }
    }
    // Pure-JS would return true; verifier says false -> proves bypass + routing.
    const result = await tx.verify('scripts only', undefined, undefined, verifier)
    expect(called).toBe(1)
    expect(result).toBe(false)
  })

  it('returns true when the verifier approves', async () => {
    const tx = await buildValidTx()
    const verifier: BdkVerifierInterface = { verifyScripts: async () => true }
    const result = await tx.verify('scripts only', undefined, undefined, verifier)
    expect(result).toBe(true)
  })

  it('does not hash an already-linked transaction graph for scripts-only verification', async () => {
    const tx = await buildValidTx()
    const sourceTransaction = tx.inputs[0].sourceTransaction as Transaction
    tx.inputs[0].sourceTXID = sourceTransaction.id('hex')
    const txId = jest.spyOn(tx, 'id')
    const sourceId = jest.spyOn(sourceTransaction, 'id')

    await expect(tx.verify('scripts only', undefined, undefined, {
      verifyScripts: async () => true
    })).resolves.toBe(true)

    expect(txId).not.toHaveBeenCalled()
    expect(sourceId).not.toHaveBeenCalled()
  })

  it('propagates a verifier throw (strict, no fallback)', async () => {
    const tx = await buildValidTx()
    const verifier: BdkVerifierInterface = {
      verifyScripts: async () => { throw new Error('wasm unavailable') }
    }
    await expect(tx.verify('scripts only', undefined, undefined, verifier))
      .rejects.toThrow('wasm unavailable')
  })

  it('passes the post-Chronicle fallback blockHeight (943816) to the verifier', async () => {
    const tx = await buildValidTx() // unmined tx -> no merkle proof -> fallback height
    let seenHeight = -1
    const verifier: BdkVerifierInterface = {
      verifyScripts: async ({ blockHeight }) => { seenHeight = blockHeight; return true }
    }
    await tx.verify('scripts only', undefined, undefined, verifier)
    expect(seenHeight).toBe(943816)
  })
})
