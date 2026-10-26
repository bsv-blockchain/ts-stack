import { MAXIMUM_SEND_WITH_TRANSACTIONS } from '@bsv/sdk/wallet/validationHelpers'
import { Beef } from '@bsv/sdk'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import { PostBeefResult, PostTxResultForTxid } from '../sdk/WalletServices.interfaces'
import { ReqHistoryNote } from '../sdk/types'
import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { WalletError } from '../sdk/WalletError'
import { doubleSha256BE } from '../utility/utilityHelpers'
import { normalizeTxid } from './validateMerklePathResult'

export const MAX_POST_BEEF_BYTES = 64 * 1024 * 1024
export const MAX_POST_BEEF_TXIDS = MAXIMUM_SEND_WITH_TRANSACTIONS
const MAX_COMPETING_TXIDS = 24
const MAX_TOTAL_NOTES = 128
const MAX_NOTE_PROPERTIES = 24
const MAX_DATA_NODES = 512
const MAX_DATA_BYTES = 64 * 1024
const MAX_BLOCK_HEIGHT = 0x7fffffff
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
const omittedDiagnosticKeys = new Set(['rawTx', 'raws', 'beef', 'url', 'txids'])

interface CopyBudget {
  notes: number
  nodes: number
  bytes: number
}

export interface ValidatedPostBeefRequest {
  beefBytes: number[]
  txids: string[]
}

export function normalizePostRawHex(value: unknown, maximumBytes: number, name = 'rawTx'): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) invalid('maximumBytes', 'a positive safe integer')
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumBytes * 2 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(value)
  ) {
    invalid(name, `nonempty hexadecimal data no larger than ${maximumBytes} bytes`)
  }
  return value.toLowerCase()
}

export function normalizePostTxids(value: unknown, name = 'txids', allowEmpty = false): string[] {
  const txids = denseArray(value, name, MAX_POST_BEEF_TXIDS).map((txid, index) =>
    normalizeTxid(txid, `${name}[${index}]`)
  )
  if ((!allowEmpty && txids.length === 0) || new Set(txids).size !== txids.length) {
    invalid(name, `${allowEmpty ? '0' : '1'} through ${MAX_POST_BEEF_TXIDS} unique transaction IDs`)
  }
  return txids
}

function invalid(name: string, requirement: string): never {
  throw new WERR_INVALID_PARAMETER(name, requirement)
}

function plainDescriptors(value: unknown, name: string): Record<string, PropertyDescriptor> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(name, 'an accessor-free plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(name, 'an accessor-free plain data object')
  const result = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(result).some(property => property.get != null || property.set != null)
  ) {
    invalid(name, 'accessor-free data properties without symbols')
  }
  return result
}

function read(source: Record<string, PropertyDescriptor>, property: string): unknown {
  return source[property]?.value
}

function denseArray(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(name, `a dense array of at most ${maximum} items`)
  const properties = Object.getOwnPropertyDescriptors(value)
  const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length !== expected.size ||
    Object.keys(properties).some(key => !expected.has(key)) ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    invalid(name, 'an accessor-free dense array without extra properties')
  }
  return Array.from({ length: value.length }, (_, index) => properties[String(index)].value)
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || toArray(value, 'utf8').length > maximum) {
    invalid(name, `1 through ${maximum} UTF-8 bytes`)
  }
  if (/\p{Cc}/u.test(value)) invalid(name, 'text without control characters')
  return value
}

function copyJsonValue(value: unknown, name: string, budget: CopyBudget, depth = 0): unknown {
  if (budget.nodes-- <= 0 || depth > 4) invalid(name, 'bounded JSON-like diagnostic data')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid(name, 'a finite safe number')
    return value
  }
  if (typeof value === 'string') {
    const bytes = toArray(value, 'utf8').length
    budget.bytes -= bytes
    if (bytes > 4096 || budget.bytes < 0) invalid(name, 'bounded diagnostic strings')
    return value.replace(/\p{Cc}/gu, ' ')
  }
  if (Array.isArray(value)) {
    return denseArray(value, name, 64).map((item, index) => copyJsonValue(item, `${name}[${index}]`, budget, depth + 1))
  }
  const source = plainDescriptors(value, name)
  const keys = Object.keys(source)
  if (keys.length > 32 || keys.some(key => unsafeKeys.has(key))) invalid(name, 'at most 32 safe data properties')
  const result: Record<string, unknown> = {}
  for (const key of keys) result[key] = copyJsonValue(read(source, key), `${name}.${key}`, budget, depth + 1)
  return result
}

function copyNotes(
  value: unknown,
  name: string,
  budget: CopyBudget,
  allowInternalTimeoutNote: boolean
): ReqHistoryNote[] {
  if (value === undefined) return []
  const notes = denseArray(value, name, MAX_TOTAL_NOTES)
  if (notes.length > budget.notes) invalid(name, `at most ${MAX_TOTAL_NOTES} notes across one provider result`)
  budget.notes -= notes.length
  return notes.map((candidate, index) => {
    const noteName = `${name}[${index}]`
    const source = plainDescriptors(candidate, noteName)
    const keys = Object.keys(source)
    if (keys.length > MAX_NOTE_PROPERTIES || keys.some(key => unsafeKeys.has(key))) {
      invalid(noteName, `at most ${MAX_NOTE_PROPERTIES} safe scalar properties`)
    }
    const what = boundedText(read(source, 'what'), `${noteName}.what`, 128)
    if (what === 'postBeefServiceTimeout' && !allowInternalTimeoutNote) {
      invalid(`${noteName}.what`, 'a provider diagnostic rather than a reserved local timeout marker')
    }
    const result: ReqHistoryNote = { what }
    for (const key of keys) {
      if (key === 'what' || omittedDiagnosticKeys.has(key)) continue
      const item = read(source, key)
      if (item === undefined) continue
      if (typeof item === 'boolean') result[key] = item
      else if (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= Number.MAX_SAFE_INTEGER) {
        result[key] = item
      } else if (typeof item === 'string') {
        if (item.length > 0) result[key] = boundedText(item, `${noteName}.${key}`, key === 'when' ? 64 : 1024)
      } else {
        invalid(`${noteName}.${key}`, 'a bounded string, finite number, boolean, or absent')
      }
    }
    return result
  })
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') invalid(name, 'a boolean or absent')
  return value
}

function copyTxidResult(
  value: unknown,
  index: number,
  expected: Set<string>,
  budget: CopyBudget,
  allowInternalTimeoutNote: boolean
): PostTxResultForTxid {
  const name = `postBeef result.txidResults[${index}]`
  const source = plainDescriptors(value, name)
  const allowed = new Set([
    'txid',
    'status',
    'alreadyKnown',
    'doubleSpend',
    'blockHash',
    'blockHeight',
    'merklePath',
    'competingTxs',
    'data',
    'notes',
    'serviceError'
  ])
  if (Object.keys(source).some(key => !allowed.has(key))) invalid(name, 'only documented transaction-result fields')
  const txid = normalizeTxid(read(source, 'txid'), `${name}.txid`)
  if (!expected.has(txid)) invalid(`${name}.txid`, 'one of the exact requested transaction IDs')
  const status = read(source, 'status')
  if (status !== 'success' && status !== 'error') invalid(`${name}.status`, "'success' or 'error'")
  const alreadyKnown = optionalBoolean(read(source, 'alreadyKnown'), `${name}.alreadyKnown`)
  const doubleSpend = optionalBoolean(read(source, 'doubleSpend'), `${name}.doubleSpend`)
  const serviceError = optionalBoolean(read(source, 'serviceError'), `${name}.serviceError`)
  if (status === 'success' && (doubleSpend === true || serviceError === true)) {
    invalid(name, 'successful results without double-spend or service-error flags')
  }
  if (status === 'error' && alreadyKnown === true) invalid(name, 'already-known results classified as success')
  if (doubleSpend === true && serviceError === true) invalid(name, 'a single error class')

  let competingTxs: string[] | undefined
  const rawCompeting = read(source, 'competingTxs')
  if (rawCompeting !== undefined) {
    if (doubleSpend !== true) invalid(`${name}.competingTxs`, 'present only for a double-spend result')
    competingTxs = denseArray(rawCompeting, `${name}.competingTxs`, MAX_COMPETING_TXIDS).map((item, itemIndex) =>
      normalizeTxid(item, `${name}.competingTxs[${itemIndex}]`)
    )
    if (competingTxs.includes(txid) || new Set(competingTxs).size !== competingTxs.length) {
      invalid(`${name}.competingTxs`, 'unique competing IDs that exclude the submitted transaction')
    }
  }

  const result: PostTxResultForTxid = { txid, status }
  if (alreadyKnown !== undefined) result.alreadyKnown = alreadyKnown
  if (doubleSpend !== undefined) result.doubleSpend = doubleSpend
  if (serviceError !== undefined) result.serviceError = serviceError
  if (competingTxs !== undefined) result.competingTxs = competingTxs
  const blockHash = read(source, 'blockHash')
  if (blockHash !== undefined) result.blockHash = normalizeTxid(blockHash, `${name}.blockHash`)
  const blockHeight = read(source, 'blockHeight')
  if (blockHeight !== undefined) {
    if (
      !Number.isSafeInteger(blockHeight) ||
      (blockHeight as number) < 0 ||
      (blockHeight as number) > MAX_BLOCK_HEIGHT
    ) {
      invalid(`${name}.blockHeight`, `an integer from 0 through ${MAX_BLOCK_HEIGHT}, or absent`)
    }
    result.blockHeight = blockHeight as number
  }
  const data = read(source, 'data')
  if (data !== undefined) result.data = copyJsonValue(data, `${name}.data`, budget) as PostTxResultForTxid['data']
  const notes = copyNotes(read(source, 'notes'), `${name}.notes`, budget, allowInternalTimeoutNote)
  if (notes.length > 0) result.notes = notes
  return result
}

export function validatePostBeefResult(
  value: unknown,
  expectedTxids: string[],
  configuredProviderName: string,
  allowInternalTimeoutNote = false
): PostBeefResult {
  const expected = new Set(expectedTxids.map((txid, index) => normalizeTxid(txid, `txids[${index}]`)))
  if (expected.size !== expectedTxids.length || expected.size === 0 || expected.size > MAX_POST_BEEF_TXIDS) {
    invalid('txids', `1 through ${MAX_POST_BEEF_TXIDS} unique transaction IDs`)
  }
  const source = plainDescriptors(value, 'postBeef result')
  if (Object.keys(source).some(key => !['name', 'status', 'error', 'txidResults', 'data', 'notes'].includes(key))) {
    invalid('postBeef result', 'only documented aggregate-result fields')
  }
  const name = boundedText(configuredProviderName, 'postBeef provider name', 128)
  const status = read(source, 'status')
  if (status !== 'success' && status !== 'error') invalid('postBeef result.status', "'success' or 'error'")
  const budget: CopyBudget = { notes: MAX_TOTAL_NOTES, nodes: MAX_DATA_NODES, bytes: MAX_DATA_BYTES }
  const txidResults = denseArray(read(source, 'txidResults'), 'postBeef result.txidResults', expected.size).map(
    (candidate, index) => copyTxidResult(candidate, index, expected, budget, allowInternalTimeoutNote)
  )
  if (txidResults.length !== expected.size || new Set(txidResults.map(result => result.txid)).size !== expected.size) {
    invalid('postBeef result.txidResults', 'exactly one result for every requested transaction ID')
  }
  const allSuccessful = txidResults.every(result => result.status === 'success')
  if ((status === 'success') !== allSuccessful) {
    invalid('postBeef result.status', 'success exactly when every requested transaction result succeeds')
  }
  const result: PostBeefResult = { name, status, txidResults }
  const error = read(source, 'error')
  if (error !== undefined) {
    if (status !== 'error' || !(error instanceof Error)) invalid('postBeef result.error', 'an Error on an error result')
    result.error = WalletError.fromUnknown(error)
  }
  const data = read(source, 'data')
  if (data !== undefined) result.data = copyJsonValue(data, 'postBeef result.data', budget) as object
  const notes = copyNotes(read(source, 'notes'), 'postBeef result.notes', budget, allowInternalTimeoutNote)
  if (notes.length > 0) result.notes = notes
  return result
}

export function validatePostTxResult(
  value: unknown,
  expectedTxid: string,
  configuredProviderName: string
): PostTxResultForTxid {
  const source = plainDescriptors(value, 'post transaction result')
  const status = read(source, 'status')
  const aggregate = validatePostBeefResult(
    {
      name: configuredProviderName,
      status,
      txidResults: [value]
    },
    [expectedTxid],
    configuredProviderName
  )
  return aggregate.txidResults[0]
}

export function validatePostTxResultOrServiceError(
  value: unknown,
  expectedTxid: string,
  configuredProviderName: string
): PostTxResultForTxid {
  try {
    return validatePostTxResult(value, expectedTxid, configuredProviderName)
  } catch {
    return makePostBeefServiceError(configuredProviderName, [expectedTxid], 'postBeefServiceError').txidResults[0]
  }
}

export function validatePostBeefResultOrServiceError(
  value: unknown,
  expectedTxids: string[],
  configuredProviderName: string
): PostBeefResult {
  try {
    return validatePostBeefResult(value, expectedTxids, configuredProviderName)
  } catch {
    return makePostBeefServiceError(configuredProviderName, expectedTxids, 'postBeefServiceError')
  }
}

export function snapshotPostBeefRequest(beef: Beef, txids: string[]): ValidatedPostBeefRequest {
  if (!(beef instanceof Beef)) invalid('beef', 'a BEEF instance')
  const normalizedTxids = normalizePostTxids(txids)
  const beefBytes = Array.from(beef.toBinary())
  if (beefBytes.length === 0 || beefBytes.length > MAX_POST_BEEF_BYTES) {
    invalid('beef', `a serialized BEEF no larger than ${MAX_POST_BEEF_BYTES} bytes`)
  }
  const owned = Beef.fromBinaryStrict(beefBytes)
  for (const [index, txid] of normalizedTxids.entries()) {
    const rawTx = owned.findTxid(txid)?.rawTx
    if (rawTx == null || toHex(doubleSha256BE(Array.from(rawTx))) !== txid) {
      invalid(`txids[${index}]`, 'a raw transaction with the exact ID in the submitted BEEF')
    }
  }
  return { beefBytes, txids: normalizedTxids }
}

export function makePostBeefServiceError(
  providerName: string,
  txids: string[],
  what: 'postBeefServiceError' | 'postBeefServiceTimeout',
  timeoutMs?: number
): PostBeefResult {
  const candidate: PostBeefResult = {
    name: providerName,
    status: 'error',
    txidResults: txids.map(txid => ({ txid, status: 'error', serviceError: true })),
    notes: [
      {
        when: new Date().toISOString(),
        what,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      }
    ]
  }
  return validatePostBeefResult(candidate, txids, providerName, true)
}
