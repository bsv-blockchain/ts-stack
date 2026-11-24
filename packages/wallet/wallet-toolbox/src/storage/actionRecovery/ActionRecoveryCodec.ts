import { Beef, PublicKey, Transaction } from '@bsv/sdk'
import type {
  StorageCreateActionResult,
  StorageCreateTransactionSdkInput,
  StorageCreateTransactionSdkOutput
} from '../../sdk/WalletStorage.interfaces'
import { ACTION_RECOVERY_RECORD_BYTES, actionRecoveryJSON, encodeActionRecoveryBytes, requireValue } from './ActionRecoveryEncoding'
export { ACTION_RECOVERY_RECORD_BYTES, actionRecoveryJSON, encodeActionRecoveryBytes } from './ActionRecoveryEncoding'
import type { ActionRecoveryPlan } from './ActionRecoveryPlan'

const maximumItems = 2048


function parse(text: string): unknown {
  requireValue(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= ACTION_RECOVERY_RECORD_BYTES)
  const value: unknown = JSON.parse(text)
  requireValue(actionRecoveryJSON(value) === text)
  return value
}

function object(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  requireValue(typeof value === 'object' && value !== null && !Array.isArray(value))
  requireValue(required.every(key => Object.hasOwn(value, key)))
  requireValue(Object.keys(value).every(key => required.includes(key) || optional.includes(key)))
}

function text(value: unknown, maximum = 4096): asserts value is string {
  requireValue(typeof value === 'string' && Buffer.from(value, 'utf8').toString('utf8') === value && Buffer.byteLength(value, 'utf8') <= maximum)
}

function integer(value: unknown, maximum = 0xffffffff): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum)
}

function bytes(value: unknown): number[] {
  text(value, ACTION_RECOVERY_RECORD_BYTES)
  const decoded = Buffer.from(value, 'base64')
  requireValue(decoded.toString('base64') === value)
  return Array.from(decoded)
}

function hex(value: unknown): asserts value is string {
  text(value, ACTION_RECOVERY_RECORD_BYTES)
  requireValue(value.length % 2 === 0 && /^[0-9a-f]*$/.test(value))
}

function provided(value: unknown): void {
  requireValue(value === 'you' || value === 'storage' || value === 'you-and-storage')
}

function optionalText(record: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) if (record[key] !== undefined) text(record[key])
}

function input(value: unknown): StorageCreateTransactionSdkInput {
  const optional = ['sourceTransaction', 'spendingDescription', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey']
  object(value, ['vin', 'sourceTxid', 'sourceVout', 'sourceSatoshis', 'sourceLockingScript', 'unlockingScriptLength', 'providedBy', 'type'], optional)
  integer(value.vin, maximumItems - 1)
  text(value.sourceTxid)
  requireValue(/^[0-9a-f]{64}$/.test(value.sourceTxid))
  integer(value.sourceVout)
  integer(value.sourceSatoshis, 2100000000000000)
  integer(value.unlockingScriptLength, ACTION_RECOVERY_RECORD_BYTES)
  hex(value.sourceLockingScript)
  provided(value.providedBy)
  text(value.type)
  optionalText(value, optional.filter(key => key !== 'sourceTransaction'))
  if (value.senderIdentityKey !== undefined) requireValue(PublicKey.fromString(value.senderIdentityKey as string).validate())
  const result = { ...value } as unknown as StorageCreateTransactionSdkInput
  if (value.sourceTransaction !== undefined) {
    result.sourceTransaction = bytes(value.sourceTransaction)
    requireValue(Transaction.fromBinary(result.sourceTransaction).id('hex') === result.sourceTxid)
  }
  return result
}

function output(value: unknown): StorageCreateTransactionSdkOutput {
  const optional = ['basket', 'customInstructions', 'purpose', 'derivationSuffix']
  object(value, ['vout', 'providedBy', 'lockingScript', 'satoshis', 'outputDescription', 'tags'], optional)
  integer(value.vout, maximumItems - 1)
  provided(value.providedBy)
  hex(value.lockingScript)
  integer(value.satoshis, 2100000000000000)
  text(value.outputDescription)
  optionalText(value, optional)
  requireValue(Array.isArray(value.tags) && value.tags.length <= maximumItems)
  for (const tag of value.tags) text(tag, 300)
  return { ...value, tags: [...value.tags] } as unknown as StorageCreateTransactionSdkOutput
}

function encodedResult(result: StorageCreateActionResult): unknown {
  return {
    ...result,
    inputBeef: result.inputBeef === undefined ? undefined : encodeActionRecoveryBytes(result.inputBeef),
    inputs: result.inputs.map(item => ({
      ...item,
      sourceTransaction: item.sourceTransaction === undefined ? undefined : encodeActionRecoveryBytes(item.sourceTransaction)
    }))
  }
}

function decodedResult(value: unknown): StorageCreateActionResult {
  object(value, ['reference', 'version', 'lockTime', 'inputs', 'outputs', 'derivationPrefix', 'inputBeef'], ['noSendChangeOutputVouts'])
  text(value.reference)
  requireValue(value.reference.length > 0)
  text(value.derivationPrefix)
  integer(value.version)
  integer(value.lockTime)
  requireValue(Array.isArray(value.inputs) && value.inputs.length > 0 && value.inputs.length <= maximumItems)
  requireValue(Array.isArray(value.outputs) && value.outputs.length <= maximumItems)
  const inputs = value.inputs.map(input), outputs = value.outputs.map(output)
  requireValue(inputs.every((item, index) => item.vin === index))
  requireValue(new Set(inputs.map(item => `${item.sourceTxid}.${item.sourceVout}`)).size === inputs.length)
  requireValue(new Set(outputs.map(item => item.vout)).size === outputs.length)
  requireValue(outputs.every(item => item.vout < outputs.length))
  const inputBeef = bytes(value.inputBeef)
  Beef.fromBinaryStrict(inputBeef)
  const result: StorageCreateActionResult = {
    reference: value.reference, version: value.version, lockTime: value.lockTime,
    derivationPrefix: value.derivationPrefix, inputs, outputs, inputBeef
  }
  if (value.noSendChangeOutputVouts !== undefined) {
    requireValue(Array.isArray(value.noSendChangeOutputVouts))
    requireValue(new Set(value.noSendChangeOutputVouts).size === value.noSendChangeOutputVouts.length)
    for (const index of value.noSendChangeOutputVouts) integer(index, outputs.length - 1)
    result.noSendChangeOutputVouts = [...value.noSendChangeOutputVouts] as number[]
  }
  return result
}

export function encodeActionRecoveryResult(result: StorageCreateActionResult): string {
  const encoded = actionRecoveryJSON(encodedResult(result))
  decodeActionRecoveryResult(encoded)
  return encoded
}

export function decodeActionRecoveryResult(encoded: string): StorageCreateActionResult {
  return decodedResult(parse(encoded))
}

export function encodeActionRecoveryPlan(plan: ActionRecoveryPlan): string {
  const encoded = actionRecoveryJSON({ result: encodedResult(plan.result), fundingTxids: plan.fundingTxids })
  decodeActionRecoveryPlan(encoded)
  return encoded
}

export function decodeActionRecoveryPlan(encoded: string): ActionRecoveryPlan {
  const value = parse(encoded)
  object(value, ['result', 'fundingTxids'])
  requireValue(Array.isArray(value.fundingTxids) && value.fundingTxids.length <= maximumItems)
  for (const txid of value.fundingTxids) requireValue(typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid))
  requireValue(new Set(value.fundingTxids).size === value.fundingTxids.length)
  const result = decodedResult(value.result)
  const inputTxids = new Set(result.inputs.map(item => item.sourceTxid))
  requireValue(value.fundingTxids.every(txid => inputTxids.has(txid)))
  return { result, fundingTxids: [...value.fundingTxids] as string[] }
}
