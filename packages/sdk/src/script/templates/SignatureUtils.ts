import TransactionSignature from '../../primitives/TransactionSignature.js'
import Transaction from '../../transaction/Transaction.js'
import Script from '../Script.js'
import { verifyNotNull } from '../../primitives/utils.js'

const MAX_SATOSHIS = 21e14
const MAX_UINT32 = 0xffffffff

function requireUInt32 (value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_UINT32) {
    throw new Error(`${name} must be an unsigned 32-bit integer`)
  }
  return value as number
}

function requireSatoshis (value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SATOSHIS) {
    throw new Error(`${name} must be a valid number of satoshis`)
  }
  return value as number
}

function requireTxid (value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hexadecimal transaction ID`)
  }
  return value.toLowerCase()
}

function requireScript (value: unknown, name: string): Script {
  if (value == null || typeof value !== 'object' || typeof (value as Script).toHex !== 'function') {
    throw new Error(`${name} must be a Script`)
  }
  const hex = (value as Script).toHex()
  if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error(`${name} must serialize to a valid hexadecimal script`)
  }
  return value as Script
}

/**
 * Computes the signature scope flags from the given signing parameters.
 */
export function computeSignatureScope (
  signOutputs: 'all' | 'none' | 'single',
  anyoneCanPay: boolean
): number {
  if (signOutputs !== 'all' && signOutputs !== 'none' && signOutputs !== 'single') {
    throw new Error('signOutputs must be "all", "none", or "single"')
  }
  if (typeof anyoneCanPay !== 'boolean') {
    throw new TypeError('anyoneCanPay must be a boolean')
  }
  let signatureScope = TransactionSignature.SIGHASH_FORKID
  if (signOutputs === 'all') {
    signatureScope |= TransactionSignature.SIGHASH_ALL
  }
  if (signOutputs === 'none') {
    signatureScope |= TransactionSignature.SIGHASH_NONE
  }
  if (signOutputs === 'single') {
    signatureScope |= TransactionSignature.SIGHASH_SINGLE
  }
  if (anyoneCanPay) {
    signatureScope |= TransactionSignature.SIGHASH_ANYONECANPAY
  }
  return signatureScope
}

/**
 * Resolves and validates the source transaction details needed for signing.
 * Returns the resolved sourceTXID, sourceSatoshis, lockingScript, and otherInputs.
 */
export function resolveSourceDetails (
  tx: Transaction,
  inputIndex: number,
  providedSourceSatoshis?: number,
  providedLockingScript?: Script
): {
    sourceTXID: string
    sourceSatoshis: number
    lockingScript: Script
    otherInputs: typeof tx.inputs
    allInputs: typeof tx.inputs
} {
  if (tx == null || !Array.isArray(tx.inputs)) {
    throw new Error('A transaction with inputs is required for transaction signing.')
  }
  if (!Number.isSafeInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`inputIndex ${inputIndex} is outside the transaction input range`)
  }
  const input = tx.inputs[inputIndex]
  const sourceOutputIndex = requireUInt32(input.sourceOutputIndex, 'input.sourceOutputIndex')
  const providedSourceTXID = input.sourceTXID === undefined
    ? undefined
    : requireTxid(input.sourceTXID, 'input.sourceTXID')
  const embeddedSourceTXID = input.sourceTransaction === undefined
    ? undefined
    : requireTxid(input.sourceTransaction.id('hex'), 'input.sourceTransaction ID')
  if (
    providedSourceTXID !== undefined &&
    embeddedSourceTXID !== undefined &&
    providedSourceTXID !== embeddedSourceTXID
  ) {
    throw new Error('The input sourceTXID does not match the input sourceTransaction.')
  }
  const sourceTXID = providedSourceTXID ?? embeddedSourceTXID
  if (sourceTXID === undefined) {
    throw new Error(
      'The input sourceTXID or sourceTransaction is required for transaction signing.'
    )
  }

  const sourceOutput = input.sourceTransaction?.outputs[sourceOutputIndex]
  if (input.sourceTransaction !== undefined && sourceOutput == null) {
    throw new Error(
      `The input sourceTransaction has no output at index ${sourceOutputIndex}.`
    )
  }
  const explicitSourceSatoshis = providedSourceSatoshis === undefined
    ? undefined
    : requireSatoshis(providedSourceSatoshis, 'sourceSatoshis')
  const embeddedSourceSatoshis = sourceOutput?.satoshis === undefined
    ? undefined
    : requireSatoshis(sourceOutput.satoshis, 'sourceTransaction output satoshis')
  if (
    explicitSourceSatoshis !== undefined &&
    embeddedSourceSatoshis !== undefined &&
    explicitSourceSatoshis !== embeddedSourceSatoshis
  ) {
    throw new Error('The sourceSatoshis does not match the input sourceTransaction output.')
  }
  const sourceSatoshis = explicitSourceSatoshis ?? embeddedSourceSatoshis
  if (sourceSatoshis === undefined) {
    throw new Error(
      'The sourceSatoshis or input sourceTransaction is required for transaction signing.'
    )
  }

  const explicitLockingScript = providedLockingScript === undefined
    ? undefined
    : requireScript(providedLockingScript, 'lockingScript')
  const embeddedLockingScript = sourceOutput?.lockingScript === undefined
    ? undefined
    : requireScript(sourceOutput.lockingScript, 'sourceTransaction output lockingScript')
  if (
    explicitLockingScript !== undefined &&
    embeddedLockingScript !== undefined &&
    explicitLockingScript.toHex().toLowerCase() !== embeddedLockingScript.toHex().toLowerCase()
  ) {
    throw new Error('The lockingScript does not match the input sourceTransaction output.')
  }
  const lockingScript = explicitLockingScript ?? embeddedLockingScript
  if (lockingScript === undefined) {
    throw new Error(
      'The lockingScript or input sourceTransaction is required for transaction signing.'
    )
  }

  return {
    sourceTXID,
    sourceSatoshis,
    lockingScript,
    allInputs: tx.inputs,
    // Preserve the public helper's legacy result without paying for it unless a
    // caller explicitly reads the property.
    get otherInputs () {
      return tx.inputs.filter((_, index) => index !== inputIndex)
    }
  }
}

/** Parameters for formatting the transaction preimage */
export interface FormatPreimageParams {
  tx: Transaction
  inputIndex: number
  signatureScope: number
  sourceTXID: string
  sourceSatoshis: number
  lockingScript: Script
  otherInputs?: Transaction['inputs']
  allInputs?: Transaction['inputs']
  inputSequence?: number
}

/**
 * Formats the transaction preimage for signing.
 */
export function formatPreimage (params: FormatPreimageParams): number[] {
  const { tx, inputIndex, signatureScope, sourceTXID, sourceSatoshis, lockingScript, otherInputs, allInputs, inputSequence } = params
  const input = tx.inputs[inputIndex]
  requireUInt32(input.sourceOutputIndex, 'input.sourceOutputIndex')
  requireSatoshis(sourceSatoshis, 'sourceSatoshis')
  requireTxid(sourceTXID, 'sourceTXID')
  requireScript(lockingScript, 'lockingScript')
  requireUInt32(signatureScope, 'signatureScope')
  const sequence = inputSequence ?? verifyNotNull(input.sequence, 'input.sequence must have value')
  requireUInt32(sequence, 'inputSequence')
  return TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: verifyNotNull(input.sourceOutputIndex, 'input.sourceOutputIndex must have value'),
    sourceSatoshis,
    transactionVersion: tx.version,
    otherInputs: otherInputs ?? [],
    allInputs,
    inputIndex,
    outputs: tx.outputs,
    inputSequence: sequence,
    subscript: lockingScript,
    lockTime: tx.lockTime,
    scope: signatureScope,
    cache: tx.getSignatureHashCache()
  })
}
