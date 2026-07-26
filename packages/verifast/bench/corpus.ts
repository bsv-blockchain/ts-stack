import { Transaction, Script, P2PKH, PrivateKey, MerklePath, Spend } from '@bsv/sdk'

export interface CorpusEntry {
  name: string
  tx: Transaction
  expected: boolean
}

/** Reconstruct the same per-input Spend objects used by Transaction.verify. */
export function spendsForTransaction(tx: Transaction): Spend[] {
  return tx.inputs.map((input, inputIndex) => {
    if (input.sourceTransaction === undefined)
      throw new Error(`Input ${inputIndex} has no source transaction`)
    if (input.unlockingScript === undefined)
      throw new Error(`Input ${inputIndex} has no unlocking script`)
    const sourceOutput = input.sourceTransaction.outputs[input.sourceOutputIndex]
    if (sourceOutput === undefined)
      throw new Error(`Input ${inputIndex} references a missing source output`)
    return new Spend({
      sourceTXID: input.sourceTXID ?? input.sourceTransaction.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: sourceOutput.satoshis ?? 0,
      lockingScript: sourceOutput.lockingScript,
      transactionVersion: tx.version,
      otherInputs: [],
      allInputs: tx.inputs,
      outputs: tx.outputs,
      inputIndex,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime
    })
  })
}

function markMined(tx: Transaction, blockHeight = 800000): void {
  tx.merklePath = new MerklePath(blockHeight, [
    [
      { offset: 0, hash: tx.id('hex'), txid: true },
      { offset: 1, duplicate: true }
    ]
  ])
}

async function fundedP2pkhSource(key: PrivateKey, count: number): Promise<Transaction> {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  for (let i = 0; i < count; i++) {
    source.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(key.toAddress()) })
  }
  markMined(source)
  return source
}

async function p2pkhTx(inputCount: number): Promise<Transaction> {
  const key = new PrivateKey(1000 + inputCount)
  const source = await fundedP2pkhSource(key, inputCount)
  const tx = new Transaction()
  for (let i = 0; i < inputCount; i++) {
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: i,
      unlockingScriptTemplate: new P2PKH().unlock(key)
    })
  }
  tx.addOutput({ satoshis: 500, lockingScript: Script.fromASM('OP_TRUE') })
  await tx.sign()
  return tx
}

async function scriptTx(lockingASM: string, unlockingASM = ''): Promise<Transaction> {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 1000, lockingScript: Script.fromASM(lockingASM) })
  markMined(source)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: unlockingASM.length === 0 ? new Script() : Script.fromASM(unlockingASM)
  })
  tx.addOutput({ satoshis: 500, lockingScript: Script.fromASM('OP_TRUE') })
  return tx
}

function corruptUnlockingScript(tx: Transaction, inputIndex: number): void {
  const unlockingScript = tx.inputs[inputIndex].unlockingScript
  if (unlockingScript === undefined) throw new Error('cannot corrupt a missing unlocking script')
  const bytes = unlockingScript.toBinary()
  bytes[Math.max(1, Math.floor(bytes.length / 2))] ^= 1
  tx.inputs[inputIndex].unlockingScript = Script.fromBinary(bytes)
}

/** Deterministic positive and negative vectors shared by tests and benchmarks. */
export async function buildCorpus(): Promise<CorpusEntry[]> {
  const one = await p2pkhTx(1)
  const five = await p2pkhTx(5)
  const twenty = await p2pkhTx(20)

  const badSignature = await p2pkhTx(1)
  corruptUnlockingScript(badSignature, 0)

  const mixedInvalid = await p2pkhTx(5)
  corruptUnlockingScript(mixedInvalid, 3)

  return [
    { name: 'p2pkh-1in-valid', tx: one, expected: true },
    { name: 'p2pkh-5in-valid', tx: five, expected: true },
    { name: 'p2pkh-20in-valid', tx: twenty, expected: true },
    { name: 'op-true-valid', tx: await scriptTx('OP_TRUE'), expected: true },
    {
      name: 'arithmetic-valid',
      tx: await scriptTx('OP_2 OP_3 OP_ADD OP_5 OP_EQUAL'),
      expected: true
    },
    {
      name: 'sha256-preimage-valid',
      tx: await scriptTx(
        'OP_SHA256 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824 OP_EQUAL',
        '68656c6c6f'
      ),
      expected: true
    },
    { name: 'op-false-invalid', tx: await scriptTx('OP_FALSE'), expected: false },
    { name: 'p2pkh-corrupt-signature', tx: badSignature, expected: false },
    { name: 'p2pkh-5in-one-corrupt-signature', tx: mixedInvalid, expected: false }
  ]
}
