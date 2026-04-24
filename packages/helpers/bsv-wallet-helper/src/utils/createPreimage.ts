import {
  Transaction,
  Script,
  TransactionSignature
} from '@bsv/sdk'

export function calculatePreimage (
  tx: Transaction,
  inputIndex: number,
  signOutputs: 'all' | 'none' | 'single',
  anyoneCanPay: boolean,
  sourceSatoshis?: number,
  lockingScript?: Script
): { preimage: number[], signatureScope: number } {
  // Validate required parameters
  if (!tx) {
    throw new Error('Transaction is required')
  }
  if (!tx.inputs || tx.inputs.length === 0) {
    throw new Error('Transaction must have at least one input')
  }
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`Invalid inputIndex ${inputIndex}. Transaction has ${tx.inputs.length} input(s)`)
  }
  if (!['all', 'none', 'single'].includes(signOutputs)) {
    throw new Error(`Invalid signOutputs "${signOutputs}". Must be "all", "none", or "single"`)
  }

  // Build signature scope flags
  let signatureScope = TransactionSignature.SIGHASH_FORKID
  if (signOutputs === 'all') signatureScope |= TransactionSignature.SIGHASH_ALL
  if (signOutputs === 'none') signatureScope |= TransactionSignature.SIGHASH_NONE
  if (signOutputs === 'single') {
    signatureScope |= TransactionSignature.SIGHASH_SINGLE
    // SIGHASH_SINGLE requires a corresponding output at the same index
    if (!tx.outputs || inputIndex >= tx.outputs.length) {
      throw new Error(`SIGHASH_SINGLE requires output at index ${inputIndex}, but transaction only has ${tx.outputs?.length || 0} output(s)`)
    }
  }
  if (anyoneCanPay) signatureScope |= TransactionSignature.SIGHASH_ANYONECANPAY

  const input = tx.inputs[inputIndex]
  // When anyoneCanPay is true, otherInputs should be empty
  const otherInputs = anyoneCanPay ? [] : tx.inputs.filter((_, i) => i !== inputIndex)

  const sourceTXID = input.sourceTXID || input.sourceTransaction?.id('hex')
  if (!sourceTXID) {
    throw new Error(`Input ${inputIndex}: sourceTXID or sourceTransaction is required for signing`)
  }

  sourceSatoshis ||= input.sourceTransaction?.outputs[input.sourceOutputIndex].satoshis
  if (!sourceSatoshis) {
    throw new Error(`Input ${inputIndex}: sourceSatoshis or input sourceTransaction is required for signing`)
  }

  lockingScript ||= input.sourceTransaction?.outputs[input.sourceOutputIndex].lockingScript
  if (lockingScript == null) {
    throw new Error(`Input ${inputIndex}: lockingScript or input sourceTransaction is required for signing`)
  }

  return {
    preimage: TransactionSignature.format({
      sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis,
      transactionVersion: tx.version,
      otherInputs,
      inputIndex,
      outputs: tx.outputs,
      inputSequence: input.sequence || 0xffffffff,
      subscript: lockingScript,
      lockTime: tx.lockTime,
      scope: signatureScope
    }),
    signatureScope
  }
}
