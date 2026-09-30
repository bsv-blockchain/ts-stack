import { Beef, PublicKey, Transaction } from '@bsv/sdk'
import type {
  StorageCreateActionResult,
  StorageCreateTransactionSdkInput,
  StorageCreateTransactionSdkOutput
} from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { ActionRecoveryPlan } from './ActionRecoveryPlan'

export const ACTION_RECOVERY_RECORD_BYTES = 16 * 1024 * 1024
const maximumItems = 2048
type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new WERR_INVALID_OPERATION('Invalid or oversized action recovery record')
}

/** Owned, accessor-free local JSON, with fixed resource bounds and deterministic keys. */
export function actionRecoveryJSON(value: unknown): string {
  let items = 0, characters = 0
  const active = new Set<object>()
  function own(input: unknown, depth: number): JSONValue {
    requireValue(depth <= 16 && ++items <= 65536)
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') {
      requireValue(Number.isSafeInteger(input))
      return input
    }
    if (typeof input === 'string') {
      characters += input.length
      requireValue(Buffer.from(input, 'utf8').toString('utf8') === input && characters <= ACTION_RECOVERY_RECORD_BYTES)
      return input
    }
    requireValue(typeof input === 'object' && input !== null && !active.has(input))
    active.add(input)
    try {
      const keys = Reflect.ownKeys(input)
      if (Array.isArray(input)) {
        requireValue(input.length <= maximumItems && keys.length === input.length + 1)
        return Array.from({ length: input.length }, (_, index) => {
          const property = Object.getOwnPropertyDescriptor(input, String(index))
          requireValue(property !== undefined && property.enumerable && 'value' in property)
          return own(property.value, depth + 1)
        })
      }
      requireValue(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
      requireValue(keys.length <= maximumItems && keys.every(key => typeof key === 'string'))
      const fields = new Map<string, JSONValue>()
      // Preserve the stored format's UTF-16 code-unit order, independent of locale.
      for (const key of (keys as string[]).sort((left, right) => Number(left > right) - Number(left < right))) {
        own(key, depth + 1)
        const property = Object.getOwnPropertyDescriptor(input, key)!
        requireValue(property.enumerable && 'value' in property)
        if (property.value !== undefined) fields.set(key, own(property.value, depth + 1))
      }
      return Object.fromEntries(fields)
    } finally {
      active.delete(input)
    }
  }
  const json = JSON.stringify(own(value, 0))
  requireValue(Buffer.byteLength(json, 'utf8') <= ACTION_RECOVERY_RECORD_BYTES)
  return json
}

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

/** Own binary data without Buffer's coercion of out-of-range values or array holes. */
export function encodeActionRecoveryBytes(value: unknown): string {
  requireValue((Array.isArray(value) || value instanceof Uint8Array) && value.length <= ACTION_RECOVERY_RECORD_BYTES)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  const owned = Buffer.alloc(value.length)
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    requireValue(field !== undefined && field.enumerable && 'value' in field)
    const byte: unknown = field.value
    requireValue(typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)
    owned[index] = byte
  }
  return owned.toString('base64')
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
  requireValue(value.fundingTxids.every(txid => result.inputs.some(item => item.sourceTxid === txid)))
  return { result, fundingTxids: [...value.fundingTxids] as string[] }
}
