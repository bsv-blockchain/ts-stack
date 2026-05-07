/**
 * BTMSHelpers — private helper functions extracted from BTMS to reduce cognitive complexity.
 *
 * These functions are internal implementation details and are NOT part of the public API.
 */

import { BTMSToken } from './BTMSToken.js'
import { decodeOutputAmount, decodeInputAmount } from './utils.js'
import type {
  BTMSAssetMetadata,
  BTMSTransaction,
  DecodedBTMSToken,
  IncomingToken,
  GetTransactionsResult
} from './types.js'
import type { ListActionsResult, PubKeyHex, TXIDHexString } from '@bsv/sdk'
import {
  BTMS_LABEL_PREFIX,
  ISSUE_MARKER,
  DEFAULT_TOKEN_SATOSHIS
} from './constants.js'

// ---------------------------------------------------------------------------
// getTransactions helpers
// ---------------------------------------------------------------------------

/** Strip the BTMS label prefix and return payload strings. */
export function stripLabelPrefix (labels: string[]): string[] {
  return labels.map(l =>
    l.startsWith(BTMS_LABEL_PREFIX) ? l.slice(BTMS_LABEL_PREFIX.length) : l
  )
}

/** Derive the transaction type from label payloads. */
export function parseTxType (
  payloads: string[]
): 'issue' | 'send' | 'receive' | 'burn' {
  if (payloads.some(l => l.includes('type issue'))) return 'issue'
  if (payloads.some(l => l.includes('type receive'))) return 'receive'
  if (payloads.some(l => l.includes('type burn'))) return 'burn'
  return 'send'
}

/** Extract the counterparty key from label payloads. */
export function parseTxCounterparty (payloads: string[]): PubKeyHex | undefined {
  const found = payloads.find(l => l.startsWith('counterparty '))
  return found ? found.replace('counterparty ', '') : undefined
}

/** Extract a numeric timestamp from label payloads. */
export function parseTxTimestamp (payloads: string[]): number | undefined {
  const found = payloads.find(l => l.startsWith('timestamp '))
  if (!found) return undefined
  const n = Number(found.replace('timestamp ', ''))
  return Number.isFinite(n) ? n : undefined
}

/** Sum token amounts from outputs whose tag matches `tagName`. */
export function sumOutputAmountsByTag (
  outputs: NonNullable<ListActionsResult['actions'][number]['outputs']>,
  tagName: string,
  txid: TXIDHexString,
  assetId: string
): number {
  let total = 0
  for (const output of outputs) {
    if (!output.tags?.includes(tagName)) continue
    const amt = decodeOutputAmount(output, txid, assetId)
    if (amt !== null) total += amt
  }
  return total
}

/** Sum token amounts from all inputs. */
export function sumInputAmounts (
  inputs: NonNullable<ListActionsResult['actions'][number]['inputs']>,
  assetId: string
): number {
  let total = 0
  for (const input of inputs) {
    const amt = decodeInputAmount(input, assetId)
    if (amt !== null) total += amt
  }
  return total
}

/** Calculate the display amount for an `issue` or `receive` action. */
export function calcSimpleOutputAmount (
  action: ListActionsResult['actions'][number],
  tagName: string,
  assetId: string
): number {
  if (!action.outputs) return 0
  return sumOutputAmountsByTag(action.outputs, tagName, action.txid, assetId)
}

/** Calculate the amount sent (outputs tagged `btms_type_send`, with input-minus-change fallback). */
export function calcSendAmount (
  action: ListActionsResult['actions'][number],
  assetId: string
): number {
  const sendOutputs = action.outputs?.filter(o => o.tags?.includes('btms_type_send')) ?? []
  let decoded = 0
  let total = 0

  for (const output of sendOutputs) {
    const amt = decodeOutputAmount(output, action.txid, assetId)
    if (amt !== null) {
      total += amt
      decoded += 1
    }
  }

  if (decoded > 0) return total

  // Fallback: inputs − change
  const inputAmount = action.inputs ? sumInputAmounts(action.inputs, assetId) : 0
  const changeAmount = action.outputs
    ? sumOutputAmountsByTag(action.outputs, 'btms_type_change', action.txid, assetId)
    : 0
  return inputAmount - changeAmount
}

/** Calculate the amount burned (inputs − change). */
export function calcBurnAmount (
  action: ListActionsResult['actions'][number],
  assetId: string
): number {
  const inputAmount = action.inputs ? sumInputAmounts(action.inputs, assetId) : 0
  const changeAmount = action.outputs
    ? sumOutputAmountsByTag(action.outputs, 'btms_type_change', action.txid, assetId)
    : 0
  return inputAmount - changeAmount
}

/** Calculate display amount for any action type. */
export function calcActionAmount (
  action: ListActionsResult['actions'][number],
  type: 'issue' | 'send' | 'receive' | 'burn',
  assetId: string
): number {
  switch (type) {
    case 'issue': return calcSimpleOutputAmount(action, 'btms_type_issue', assetId)
    case 'receive': return calcSimpleOutputAmount(action, 'btms_type_receive', assetId)
    case 'send': return calcSendAmount(action, assetId)
    case 'burn': return calcBurnAmount(action, assetId)
  }
}

/** Map a single `listActions` action into a `BTMSTransaction`. */
export function mapActionToTransaction (
  action: ListActionsResult['actions'][number],
  assetId: string
): BTMSTransaction {
  const payloads = stripLabelPrefix(action.labels ?? [])
  const type = parseTxType(payloads)
  const counterparty = parseTxCounterparty(payloads)
  const timestamp = parseTxTimestamp(payloads)
  const direction: 'incoming' | 'outgoing' = (type === 'send' || type === 'burn') ? 'outgoing' : 'incoming'
  let amount = calcActionAmount(action, type, assetId)
  if (direction === 'outgoing') amount = -amount

  return {
    txid: action.txid,
    type,
    direction,
    amount,
    assetId,
    counterparty,
    description: action.description,
    status: action.status === 'completed' ? 'completed' : 'pending',
    timestamp
  }
}

/** Build a full `GetTransactionsResult` from a `ListActionsResult`. */
export function buildTransactionsResult (
  result: ListActionsResult,
  assetId: string
): GetTransactionsResult {
  const transactions = result.actions.map(action => mapActionToTransaction(action, assetId))
  return {
    transactions,
    total: result.totalActions || transactions.length
  }
}

// ---------------------------------------------------------------------------
// listAssets helpers
// ---------------------------------------------------------------------------

export interface AssetAccumulator {
  balance: number
  metadata?: BTMSAssetMetadata
}

/** Attempt to parse metadata (string or object). Returns undefined on failure. */
export function parseMetadata (raw: unknown): BTMSAssetMetadata | undefined {
  if (!raw) return undefined
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as BTMSAssetMetadata)
  } catch {
    return undefined
  }
}

/** Resolve the assetId for one output (handles ISSUE_MARKER). */
export function resolveOutputAssetId (
  decoded: DecodedBTMSToken,
  outpoint: string
): string | undefined {
  if (decoded.assetId === ISSUE_MARKER) {
    const [txid, outputIndexStr] = outpoint.split('.')
    const id = BTMSToken.computeAssetId(txid, Number(outputIndexStr))
    return BTMSToken.isValidAssetId(id) ? id : undefined
  }
  return BTMSToken.isValidAssetId(decoded.assetId) ? decoded.assetId : undefined
}

/** Process one wallet output and accumulate its contribution into `assetBalances`. */
export function accumulateOutputIntoBalances (
  output: { spendable?: boolean, satoshis?: number, outpoint: string, lockingScript?: string },
  assetBalances: Map<string, AssetAccumulator>
): void {
  if (!output.spendable) return
  if (output.satoshis !== DEFAULT_TOKEN_SATOSHIS) return

  const decoded = BTMSToken.decode(output.lockingScript ?? '')
  if (!decoded.valid) return

  const assetId = resolveOutputAssetId(decoded, output.outpoint)
  if (!assetId) return

  const current = assetBalances.get(assetId) ?? { balance: 0 }
  current.balance += decoded.amount
  current.metadata ??= parseMetadata(decoded.metadata)
  assetBalances.set(assetId, current)
}

/** Parse a single raw message body into an `IncomingToken`. Returns null on failure. */
export function parseIncomingMessage (
  msg: { body: string, messageId?: string, sender?: string }
): IncomingToken | null {
  try {
    const payment = JSON.parse(msg.body) as IncomingToken
    if (msg.messageId !== undefined) payment.messageId = msg.messageId
    if (msg.sender !== undefined) payment.sender = msg.sender
    return payment
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// getSpendableTokens helpers
// ---------------------------------------------------------------------------

/** Return true if the decoded token belongs to the target `assetId`. */
export function tokenMatchesAsset (
  decoded: DecodedBTMSToken,
  outpoint: string,
  assetId: string
): boolean {
  if (decoded.assetId === ISSUE_MARKER) {
    const [txid, outputIndexStr] = outpoint.split('.')
    return BTMSToken.computeAssetId(txid, Number(outputIndexStr)) === assetId
  }
  return decoded.assetId === assetId
}

// ---------------------------------------------------------------------------
// findBadOutputs helpers
// ---------------------------------------------------------------------------

export interface BadOutput { outpoint: string, reason: string }

/** Validate a single output and return a `BadOutput` entry, or null if valid. */
export function validateOutputForBadness (
  output: { outpoint: string, spendable?: boolean, satoshis?: number, lockingScript?: string }
): BadOutput | null {
  if (!output.spendable) return null

  if (output.satoshis !== DEFAULT_TOKEN_SATOSHIS) {
    return { outpoint: output.outpoint, reason: 'Unexpected satoshi value' }
  }
  if (!output.lockingScript) {
    return { outpoint: output.outpoint, reason: 'Missing locking script' }
  }

  try {
    const decoded = BTMSToken.decode(output.lockingScript)
    if (!decoded.valid) {
      return { outpoint: output.outpoint, reason: decoded.error ?? 'Invalid token encoding' }
    }
  } catch (error) {
    return {
      outpoint: output.outpoint,
      reason: error instanceof Error ? error.message : 'Failed to decode token'
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// verifyOwnership helpers
// ---------------------------------------------------------------------------

/** Verify that a single proven token's asset ID matches the proof's assetId. */
export function verifyProvenTokenAssetId (
  decoded: DecodedBTMSToken,
  txid: string,
  outputIndex: number,
  expectedAssetId: string
): void {
  const tokenAssetId = decoded.assetId === ISSUE_MARKER
    ? BTMSToken.computeAssetId(txid, outputIndex)
    : decoded.assetId
  if (tokenAssetId !== expectedAssetId) {
    throw new Error('Token asset ID does not match proof asset ID')
  }
}

