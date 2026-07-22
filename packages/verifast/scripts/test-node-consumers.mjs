import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { MerklePath, P2PKH, PrivateKey, Script, Spend, Transaction } from '@bsv/sdk'

async function buildTransaction () {
  const key = new PrivateKey(42)
  const source = new Transaction()
  source.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromASM('OP_TRUE') })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  source.merklePath = new MerklePath(777, [
    [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

const tx = await buildTransaction()
const input = tx.inputs[0]
const source = input.sourceTransaction
if (source === undefined || input.unlockingScript === undefined) throw new Error('consumer fixture is incomplete')
const spend = new Spend({
  sourceTXID: source.id('hex'),
  sourceOutputIndex: input.sourceOutputIndex,
  sourceSatoshis: source.outputs[input.sourceOutputIndex].satoshis ?? 0,
  lockingScript: source.outputs[input.sourceOutputIndex].lockingScript,
  transactionVersion: tx.version,
  otherInputs: [],
  allInputs: tx.inputs,
  outputs: tx.outputs,
  inputIndex: 0,
  unlockingScript: input.unlockingScript,
  inputSequence: input.sequence ?? 0xffffffff,
  lockTime: tx.lockTime
})
const esm = await import('@bsv/verifast')
const require = createRequire(import.meta.url)
const cjs = require('@bsv/verifast')

for (const [name, api] of [['ESM', esm], ['CommonJS', cjs]]) {
  const verifier = new api.BdkVerifier()
  assert.equal(await verifier.verifyScripts({ tx, blockHeight: 800000, consensus: true }), true, name)
  assert.equal(await verifier.verifyScriptsFromEF({
    extendedTransaction: tx.toEFBinary(),
    utxoHeights: [777],
    blockHeight: 800000,
    consensus: true
  }), true, `${name} pre-serialized EF`)
  assert.equal(await verifier.verifySpend(spend), true, `${name} Spend`)
  assert.deepEqual(await verifier.verifySpendsBatch([{ spend }, { spend }]), [true, true], `${name} Spend batch`)
  assert.equal(api.BdkErrorDomain.OK, 0, `${name} enum name`)
  assert.equal(api.BdkErrorDomain[0], 'OK', `${name} enum reverse mapping`)
  console.log(`ok - ${name} package export and real WASM verification`)
}
