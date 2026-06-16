import { Transaction, Script, P2PKH, PrivateKey, MerklePath } from '@bsv/sdk'

export interface CorpusEntry {
  name: string
  tx: Transaction
}

/** A funded source tx paying `count` P2PKH outputs to `key`, with a mock merklePath. */
async function fundedSource (key: PrivateKey, count: number): Promise<Transaction> {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  for (let i = 0; i < count; i++) {
    source.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(key.toAddress()) })
  }
  await source.sign()
  source.merklePath = new MerklePath(800000, [
    [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])
  return source
}

/** Build a P2PKH spend with `nInputs` inputs and one output. */
async function p2pkhTx (nInputs: number): Promise<Transaction> {
  const key = PrivateKey.fromRandom()
  const source = await fundedSource(key, nInputs)
  const tx = new Transaction()
  for (let i = 0; i < nInputs; i++) {
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: i, unlockingScriptTemplate: new P2PKH().unlock(key) })
  }
  tx.addOutput({ satoshis: 500, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

/**
 * Build the benchmark/equivalence corpus. Deterministic in shape; keys are random
 * (signatures vary run-to-run but validity does not).
 *
 * Intentionally P2PKH-only for v1: these spends are known-valid under the pure-JS
 * interpreter, giving a clean equivalence baseline. Multisig/CLTV vectors can be
 * added later once a real wasm validates them.
 */
export async function buildCorpus (): Promise<CorpusEntry[]> {
  return [
    { name: 'p2pkh-1in', tx: await p2pkhTx(1) },
    { name: 'p2pkh-5in', tx: await p2pkhTx(5) },
    { name: 'p2pkh-20in', tx: await p2pkhTx(20) }
  ]
}
