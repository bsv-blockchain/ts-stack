import { TransactionSignature } from '@bsv/sdk/primitives'
import type Script from '@bsv/sdk/script/Script'
import type Transaction from '@bsv/sdk/transaction/Transaction'

const MAX_SATOSHIS = 21e14
const MAX_UINT32 = 0xffffffff

export interface BoundSourceDetails {
  sourceTXID: string
  sourceSatoshis: number
  lockingScript: Script
}

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
    throw new Error(`${name} must serialize to a hexadecimal script`)
  }
  return value as Script
}

export function signatureScope(
  signOutputs: 'all' | 'none' | 'single',
  anyoneCanPay: boolean
): number
export function signatureScope(
  tx: Transaction,
  inputIndex: number,
  signOutputs: 'all' | 'none' | 'single',
  anyoneCanPay: boolean
): number
export function signatureScope(
  txOrSignOutputs: Transaction | 'all' | 'none' | 'single',
  inputIndexOrAnyoneCanPay: number | boolean,
  maybeSignOutputs?: 'all' | 'none' | 'single',
  maybeAnyoneCanPay?: boolean
): number {
  const hasTransaction = typeof txOrSignOutputs === 'object'
  const tx = hasTransaction ? txOrSignOutputs : undefined
  const inputIndex = hasTransaction ? inputIndexOrAnyoneCanPay : undefined
  const signOutputs = hasTransaction ? maybeSignOutputs : txOrSignOutputs
  const anyoneCanPay = hasTransaction ? maybeAnyoneCanPay : inputIndexOrAnyoneCanPay
  if (signOutputs !== 'all' && signOutputs !== 'none' && signOutputs !== 'single') {
    throw new Error('signOutputs must be "all", "none", or "single"')
  }
  if (typeof anyoneCanPay !== 'boolean') throw new TypeError('anyoneCanPay must be a boolean')
  if (tx !== undefined) {
    if (
      !Number.isSafeInteger(inputIndex) ||
      (inputIndex as number) < 0 ||
      (inputIndex as number) >= tx.inputs.length
    ) {
      throw new Error(`Transaction input ${String(inputIndex)} does not exist`)
    }
    if (signOutputs === 'single' && (inputIndex as number) >= tx.outputs.length) {
      throw new Error('SIGHASH_SINGLE requires an output at the signing input index')
    }
  }
  let scope = TransactionSignature.SIGHASH_FORKID
  if (signOutputs === 'all') scope |= TransactionSignature.SIGHASH_ALL
  if (signOutputs === 'none') scope |= TransactionSignature.SIGHASH_NONE
  if (signOutputs === 'single') scope |= TransactionSignature.SIGHASH_SINGLE
  if (anyoneCanPay) scope |= TransactionSignature.SIGHASH_ANYONECANPAY
  return scope
}

export function resolveBoundSource(
  tx: Transaction,
  inputIndex: number,
  providedSourceSatoshis?: number,
  providedLockingScript?: Script
): BoundSourceDetails {
  if (!Number.isSafeInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`Transaction input ${inputIndex} does not exist`)
  }
  const input = tx.inputs[inputIndex]
  const sourceOutputIndex = requireUInt32(input.sourceOutputIndex, 'input.sourceOutputIndex')
  const providedTXID =
    input.sourceTXID === undefined ? undefined : requireTxid(input.sourceTXID, 'input.sourceTXID')
  const embeddedTXID =
    input.sourceTransaction === undefined
      ? undefined
      : requireTxid(input.sourceTransaction.id('hex'), 'input.sourceTransaction ID')
  if (providedTXID !== undefined && embeddedTXID !== undefined && providedTXID !== embeddedTXID) {
    throw new Error('input.sourceTXID does not match input.sourceTransaction')
  }
  const sourceTXID = providedTXID ?? embeddedTXID
  if (sourceTXID === undefined) {
    throw new Error('The input sourceTXID or sourceTransaction is required for signing')
  }

  const sourceOutput = input.sourceTransaction?.outputs[sourceOutputIndex]
  if (input.sourceTransaction !== undefined && sourceOutput == null) {
    throw new Error(`input.sourceTransaction has no output at index ${sourceOutputIndex}`)
  }
  const explicitSatoshis =
    providedSourceSatoshis === undefined
      ? undefined
      : requireSatoshis(providedSourceSatoshis, 'sourceSatoshis')
  const embeddedSatoshis =
    sourceOutput?.satoshis === undefined
      ? undefined
      : requireSatoshis(sourceOutput.satoshis, 'source output satoshis')
  if (
    explicitSatoshis !== undefined &&
    embeddedSatoshis !== undefined &&
    explicitSatoshis !== embeddedSatoshis
  ) {
    throw new Error('sourceSatoshis does not match input.sourceTransaction output')
  }
  const sourceSatoshis = explicitSatoshis ?? embeddedSatoshis
  if (sourceSatoshis === undefined) {
    throw new Error('The sourceSatoshis or input sourceTransaction is required for signing')
  }

  const explicitScript =
    providedLockingScript === undefined
      ? undefined
      : requireScript(providedLockingScript, 'lockingScript')
  const embeddedScript =
    sourceOutput?.lockingScript === undefined
      ? undefined
      : requireScript(sourceOutput.lockingScript, 'source output lockingScript')
  if (
    explicitScript !== undefined &&
    embeddedScript !== undefined &&
    explicitScript.toHex().toLowerCase() !== embeddedScript.toHex().toLowerCase()
  ) {
    throw new Error('lockingScript does not match input.sourceTransaction output')
  }
  const lockingScript = explicitScript ?? embeddedScript
  if (lockingScript === undefined) {
    throw new Error('The lockingScript or input sourceTransaction is required for signing')
  }
  return { sourceTXID, sourceSatoshis, lockingScript }
}

export function boundPreimage(
  tx: Transaction,
  inputIndex: number,
  source: BoundSourceDetails,
  scope: number,
  subscript: Script = source.lockingScript
): number[] {
  const input = tx.inputs[inputIndex]
  const sourceOutputIndex = requireUInt32(input.sourceOutputIndex, 'input.sourceOutputIndex')
  const inputSequence = requireUInt32(input.sequence ?? MAX_UINT32, 'input.sequence')
  requireUInt32(scope, 'signature scope')
  return TransactionSignature.format({
    sourceTXID: source.sourceTXID,
    sourceOutputIndex,
    sourceSatoshis: source.sourceSatoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, index) => index !== inputIndex),
    allInputs: tx.inputs,
    inputIndex,
    outputs: tx.outputs,
    inputSequence,
    subscript,
    lockTime: tx.lockTime,
    scope
  })
}
