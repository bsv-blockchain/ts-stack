import { Transaction, Script, TransactionSignature } from '@bsv/sdk'

const MAX_SATOSHIS = 21e14
const MAX_UINT32 = 0xffffffff

function requireUInt32(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_UINT32) {
    throw new Error(`${name} must be an unsigned 32-bit integer`)
  }
  return value as number
}

function requireSatoshis(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SATOSHIS) {
    throw new Error(`${name} must be a valid number of satoshis`)
  }
  return value as number
}

function requireTxid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hexadecimal transaction ID`)
  }
  return value.toLowerCase()
}

function requireScript(value: unknown, name: string): Script {
  if (value == null || typeof value !== 'object' || typeof (value as Script).toHex !== 'function') {
    throw new Error(`${name} must be a Script`)
  }
  const hex = (value as Script).toHex()
  if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error(`${name} must serialize to a valid hexadecimal script`)
  }
  return value as Script
}

export function calculatePreimage(
  tx: Transaction,
  inputIndex: number,
  signOutputs: 'all' | 'none' | 'single',
  anyoneCanPay: boolean,
  sourceSatoshis?: number,
  lockingScript?: Script
): { preimage: number[]; signatureScope: number } {
  // Validate required parameters
  if (!tx) {
    throw new Error('Transaction is required')
  }
  if (!tx.inputs || tx.inputs.length === 0) {
    throw new Error('Transaction must have at least one input')
  }
  if (!Number.isSafeInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(
      `Invalid inputIndex ${inputIndex}. Transaction has ${tx.inputs.length} input(s)`
    )
  }
  if (!['all', 'none', 'single'].includes(signOutputs)) {
    throw new Error(`Invalid signOutputs "${signOutputs}". Must be "all", "none", or "single"`)
  }
  if (typeof anyoneCanPay !== 'boolean') {
    throw new TypeError('anyoneCanPay must be a boolean')
  }

  // Build signature scope flags
  let signatureScope = TransactionSignature.SIGHASH_FORKID
  if (signOutputs === 'all') signatureScope |= TransactionSignature.SIGHASH_ALL
  if (signOutputs === 'none') signatureScope |= TransactionSignature.SIGHASH_NONE
  if (signOutputs === 'single') {
    signatureScope |= TransactionSignature.SIGHASH_SINGLE
    // SIGHASH_SINGLE requires a corresponding output at the same index
    if (!tx.outputs || inputIndex >= tx.outputs.length) {
      throw new Error(
        `SIGHASH_SINGLE requires output at index ${inputIndex}, but transaction only has ${tx.outputs?.length || 0} output(s)`
      )
    }
  }
  if (anyoneCanPay) signatureScope |= TransactionSignature.SIGHASH_ANYONECANPAY

  const input = tx.inputs[inputIndex]
  const sourceOutputIndex = requireUInt32(
    input.sourceOutputIndex,
    `Input ${inputIndex}: sourceOutputIndex`
  )
  // When anyoneCanPay is true, otherInputs should be empty
  const otherInputs = anyoneCanPay ? [] : tx.inputs.filter((_, i) => i !== inputIndex)

  const providedSourceTXID =
    input.sourceTXID === undefined
      ? undefined
      : requireTxid(input.sourceTXID, `Input ${inputIndex}: sourceTXID`)
  const embeddedSourceTXID = input.sourceTransaction
    ? requireTxid(input.sourceTransaction.id('hex'), `Input ${inputIndex}: sourceTransaction ID`)
    : undefined
  if (
    providedSourceTXID !== undefined &&
    embeddedSourceTXID !== undefined &&
    providedSourceTXID !== embeddedSourceTXID
  ) {
    throw new Error(`Input ${inputIndex}: sourceTXID does not match sourceTransaction`)
  }
  const sourceTXID = providedSourceTXID ?? embeddedSourceTXID
  if (sourceTXID === undefined) {
    throw new Error(`Input ${inputIndex}: sourceTXID or sourceTransaction is required for signing`)
  }

  const sourceOutput = input.sourceTransaction?.outputs[sourceOutputIndex]
  if (input.sourceTransaction && sourceOutput == null) {
    throw new Error(
      `Input ${inputIndex}: sourceTransaction has no output at index ${sourceOutputIndex}`
    )
  }
  const embeddedSourceSatoshis =
    sourceOutput?.satoshis === undefined
      ? undefined
      : requireSatoshis(sourceOutput.satoshis, `Input ${inputIndex}: source output satoshis`)
  const providedSourceSatoshis =
    sourceSatoshis === undefined
      ? undefined
      : requireSatoshis(sourceSatoshis, `Input ${inputIndex}: sourceSatoshis`)
  if (
    providedSourceSatoshis !== undefined &&
    embeddedSourceSatoshis !== undefined &&
    providedSourceSatoshis !== embeddedSourceSatoshis
  ) {
    throw new Error(`Input ${inputIndex}: sourceSatoshis does not match sourceTransaction output`)
  }
  sourceSatoshis = providedSourceSatoshis ?? embeddedSourceSatoshis
  if (sourceSatoshis === undefined) {
    throw new Error(
      `Input ${inputIndex}: sourceSatoshis or input sourceTransaction is required for signing`
    )
  }

  const embeddedLockingScript =
    sourceOutput?.lockingScript === undefined
      ? undefined
      : requireScript(
          sourceOutput.lockingScript,
          `Input ${inputIndex}: source output lockingScript`
        )
  const providedLockingScript =
    lockingScript === undefined
      ? undefined
      : requireScript(lockingScript, `Input ${inputIndex}: lockingScript`)
  if (
    providedLockingScript !== undefined &&
    embeddedLockingScript !== undefined &&
    providedLockingScript.toHex().toLowerCase() !== embeddedLockingScript.toHex().toLowerCase()
  ) {
    throw new Error(`Input ${inputIndex}: lockingScript does not match sourceTransaction output`)
  }
  lockingScript = providedLockingScript ?? embeddedLockingScript
  if (lockingScript === undefined) {
    throw new Error(
      `Input ${inputIndex}: lockingScript or input sourceTransaction is required for signing`
    )
  }

  const inputSequence = requireUInt32(input.sequence ?? MAX_UINT32, `Input ${inputIndex}: sequence`)

  return {
    preimage: TransactionSignature.format({
      sourceTXID,
      sourceOutputIndex,
      sourceSatoshis,
      transactionVersion: tx.version,
      otherInputs,
      inputIndex,
      outputs: tx.outputs,
      inputSequence,
      subscript: lockingScript,
      lockTime: tx.lockTime,
      scope: signatureScope
    }),
    signatureScope
  }
}
