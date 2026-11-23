import Transaction from '../Transaction'
import MerklePath from '../MerklePath'
import Spend from '../../script/Spend'
import ScriptEvaluationError from '../../script/ScriptEvaluationError'

// Extended-format P2PK spend from issue #1584. The unlocking signature is a
// valid ECDSA signature whose sighash byte is 0x01 (SIGHASH_ALL, no FORKID).
// The node rejects it with "Signature must use SIGHASH_FORKID".
const FORKID_MISSING_EF =
  '020000000000000000ef01916701c7ed83aaf1f6fff65046ce30f9558da56fe7b3b763f14a5977246ce2c10000000049483045022100feb96c58d7f0decd5262bdbb07008dcf44d17ca699d7fa86434cde835c4813400220663d2f78474e679a1167c2985d416a467c1da71a1f01c44cffcffbd11913c20a01ffffffff10270000000000002321039d1abaec9f5715a15c7628244170951e0f85e87f68ca5393d3f9fc3fa23a69c8ac01282300000000000002006a00000000'

function transactionFromIssue(): Transaction {
  const tx = Transaction.fromHexEF(FORKID_MISSING_EF)
  const input = tx.inputs[0]
  const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (sourceOutput == null || input.unlockingScript == null) {
    throw new Error('Issue #1584 fixture is missing its source output')
  }
  // Rebuild the parent as a transaction and mark it proven. scripts-only
  // verification does not check headers, and the parent has no inputs of its own.
  const parent = new Transaction(
    1,
    [],
    [{ lockingScript: sourceOutput.lockingScript, satoshis: sourceOutput.satoshis }],
    0
  )
  parent.merklePath = new MerklePath(949999, [[{ offset: 0, hash: parent.id('hex'), txid: true }]])
  input.sourceTransaction = parent
  return tx
}

function spendFromIssue(tx: Transaction, verifyFlags?: string[]): Spend {
  const input = tx.inputs[0]
  const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (sourceOutput == null || input.unlockingScript == null || input.sourceTXID == null) {
    throw new Error('Issue #1584 fixture is missing its source output')
  }
  return new Spend({
    sourceTXID: input.sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: sourceOutput.satoshis ?? 0,
    lockingScript: sourceOutput.lockingScript,
    transactionVersion: tx.version,
    otherInputs: [],
    allInputs: tx.inputs,
    unlockingScript: input.unlockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    inputIndex: 0,
    outputs: tx.outputs,
    lockTime: tx.lockTime,
    verifyFlags
  })
}

describe('Transaction.verify SIGHASH_FORKID', () => {
  it('rejects the issue #1584 transaction whose signature omits SIGHASH_FORKID', async () => {
    const tx = transactionFromIssue()
    const sighash = tx.inputs[0].unlockingScript?.chunks[0]?.data?.at(-1)
    expect(sighash).toBe(0x01)
    await expect(tx.verify('scripts only')).rejects.toThrow(ScriptEvaluationError)
    await expect(tx.verify('scripts only')).rejects.toThrow('SIGHASH_FORKID')
  })

  it('rejects the same spend on the default Spend path', () => {
    const spend = spendFromIssue(transactionFromIssue())
    expect(() => spend.validateJavaScript()).toThrow('The signature must use SIGHASH_FORKID.')
  })

  it('keeps the explicit verifyFlags opt-out for a set that omits SIGHASH_FORKID', () => {
    const tx = transactionFromIssue()
    const optedOut = spendFromIssue(tx, ['DERSIG', 'STRICTENC'])
    expect(optedOut.validateJavaScript()).toBe(true)

    const enforced = spendFromIssue(tx, ['DERSIG', 'STRICTENC', 'SIGHASH_FORKID'])
    expect(() => enforced.validateJavaScript()).toThrow('The signature must use SIGHASH_FORKID.')
  })
})
