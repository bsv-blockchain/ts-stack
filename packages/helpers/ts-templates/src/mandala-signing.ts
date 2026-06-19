import { Transaction, TransactionSignature } from '@bsv/sdk'

export type SignOutputs = 'all' | 'none' | 'single'

/**
 * Builds the BIP143 sighash preimage and scope shared by the Mandala unlock templates.
 */
export function buildSighashPreimage (
  tx: Transaction,
  inputIndex: number,
  signOutputs: SignOutputs,
  anyoneCanPay: boolean
): { preimage: number[], scope: number } {
  let scope = TransactionSignature.SIGHASH_FORKID
  if (signOutputs === 'all') scope |= TransactionSignature.SIGHASH_ALL
  else if (signOutputs === 'none') scope |= TransactionSignature.SIGHASH_NONE
  else if (signOutputs === 'single') scope |= TransactionSignature.SIGHASH_SINGLE
  if (anyoneCanPay) scope |= TransactionSignature.SIGHASH_ANYONECANPAY

  const input = tx.inputs[inputIndex]
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (sourceTXID == null) throw new Error('sourceTXID or sourceTransaction required')
  if (sourceOutput?.satoshis == null) throw new Error('source satoshis required')
  if (sourceOutput.lockingScript == null) throw new Error('source lockingScript required')

  const preimage = TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: sourceOutput.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: sourceOutput.lockingScript,
    lockTime: tx.lockTime,
    scope
  })
  return { preimage, scope }
}
