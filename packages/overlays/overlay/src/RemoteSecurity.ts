import { Transaction, createPublicHTTPSFetch, type AdmittanceInstructions } from '@bsv/sdk'

export const MAX_GASP_PAGE_SIZE = 10_000
export const MAX_BASM_TXIDS = 256
export const MAX_REMOTE_JSON_BYTES = 64 * 1024 * 1024
export const MAX_GASP_NODE_JSON_BYTES = 32 * 1024 * 1024
export const MAX_RAW_TRANSACTION_BYTES = 32 * 1024 * 1024
export const REMOTE_BODY_TIMEOUT_MS = 30_000

const MAX_TOPIC_BYTES = 256
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_GASP_INPUTS = 100_000
const MAX_ERROR_SNIPPET_BYTES = 1024
const HASH_HEX = /^[0-9a-fA-F]{64}$/
const EVEN_HEX = /^(?:[0-9a-fA-F]{2})+$/

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateAdmittanceInstructions(
  value: unknown,
  tx: Transaction,
  previousCoins: number[]
): AdmittanceInstructions {
  if (
    !isRecord(value) ||
    !Array.isArray(value.outputsToAdmit) ||
    !Array.isArray(value.coinsToRetain)
  ) {
    throw new TypeError('Topic manager returned invalid admittance instructions')
  }
  const validateIndexes = (indexes: unknown[], limit: number, label: string): number[] => {
    const seen = new Set<number>()
    return indexes.map(index => {
      if (
        typeof index !== 'number' ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= limit ||
        seen.has(index)
      ) {
        throw new TypeError(`Topic manager returned invalid ${label}`)
      }
      seen.add(index)
      return index
    })
  }
  const outputsToAdmit = validateIndexes(value.outputsToAdmit, tx.outputs.length, 'outputsToAdmit')
  const coinsToRetain = validateIndexes(value.coinsToRetain, tx.inputs.length, 'coinsToRetain')
  const previousCoinSet = new Set(previousCoins)
  if (coinsToRetain.some(index => !previousCoinSet.has(index))) {
    throw new TypeError('Topic manager retained an input that is not a previous topical coin')
  }
  return { outputsToAdmit, coinsToRetain }
}

export function assertTopic(topic: unknown, label = 'topic'): asserts topic is string {
  if (
    typeof topic !== 'string' ||
    topic.length === 0 ||
    new TextEncoder().encode(topic).byteLength > MAX_TOPIC_BYTES ||
    Array.from(topic).some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new TypeError(`${label} is invalid`)
  }
}

export function assertRegistryName(value: unknown, label: string): asserts value is string {
  assertTopic(value, label)
  if (value === '__proto__' || value === 'prototype' || value === 'constructor') {
    throw new TypeError(`${label} uses a reserved object property name`)
  }
}

export function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HASH_HEX.test(value)) {
    throw new TypeError(`${label} must be 32 bytes of hex`)
  }
}

export function assertOutputIndex(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new TypeError(`${label} must be an unsigned 32-bit integer`)
  }
}

export function assertNonnegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
}

export function assertOutpoint(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${label} is invalid`)
  const separator = value.lastIndexOf('.')
  if (separator !== 64) throw new TypeError(`${label} is invalid`)
  assertHash(value.slice(0, separator), `${label} txid`)
  const index = value.slice(separator + 1)
  if (!/^(0|[1-9]\d*)$/.test(index)) throw new TypeError(`${label} is invalid`)
  assertOutputIndex(Number(index), `${label} output index`)
}

export function assertHexBytes(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxBytes * 2 ||
    (value.length !== 0 && !EVEN_HEX.test(value))
  ) {
    throw new TypeError(`${label} must be bounded, even-length hexadecimal data`)
  }
}

export function assertTxidList(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean; max?: number } = {}
): asserts value is string[] {
  const max = options.max ?? MAX_BASM_TXIDS
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.length > max) {
    throw new TypeError(
      `${label} must contain between ${options.allowEmpty === true ? 0 : 1} and ${max} txids`
    )
  }
  const seen = new Set<string>()
  for (const [index, txid] of value.entries()) {
    assertHash(txid, `${label}[${index}]`)
    const canonical = txid.toLowerCase()
    if (seen.has(canonical)) throw new TypeError(`${label} contains duplicate txids`)
    seen.add(canonical)
  }
}

export function normalizePeerEndpoint(endpoint: string): string {
  const url = new URL(endpoint)
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== ''
  ) {
    throw new TypeError(
      'Overlay peer endpoints must be credential-free HTTPS URLs without query or fragment data'
    )
  }
  return url.toString().replace(/\/$/, '')
}

export function securePeerFetch(
  endpoint: string,
  supplied?: typeof fetch
): {
  endpoint: string
  fetchImpl: typeof fetch
} {
  const normalized = normalizePeerEndpoint(endpoint)
  return {
    endpoint: normalized,
    fetchImpl: supplied ?? createPublicHTTPSFetch(new URL(normalized).origin)
  }
}

async function readBody(response: Response, maxBytes: number, truncate = false): Promise<string> {
  const declared = response.headers?.get?.('content-length')
  if (declared !== null && declared !== undefined) {
    if (!truncate && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > maxBytes)) {
      await response.body?.cancel()
      throw new RangeError(`Overlay peer response exceeds ${maxBytes} bytes`)
    }
  }

  if (response.body === null || response.body === undefined) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new RangeError(`Overlay peer response exceeds ${maxBytes} bytes`)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const bytes = await Promise.race([
      (async (): Promise<Uint8Array> => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (truncate && total + value.byteLength > maxBytes) {
            chunks.push(value.slice(0, maxBytes - total))
            total = maxBytes
            break
          }
          total += value.byteLength
          if (total > maxBytes) {
            throw new RangeError(`Overlay peer response exceeds ${maxBytes} bytes`)
          }
          chunks.push(value)
        }
        const combined = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          combined.set(chunk, offset)
          offset += chunk.byteLength
        }
        return combined
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Overlay peer response body timed out')),
          REMOTE_BODY_TIMEOUT_MS
        )
      })
    ])
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function readPeerJSON(
  response: Response,
  maxBytes = MAX_REMOTE_JSON_BYTES
): Promise<unknown> {
  const contentType = response.headers?.get?.('content-type')
  if (
    contentType !== null &&
    contentType !== undefined &&
    !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType)
  ) {
    await response.body?.cancel()
    throw new TypeError('Overlay peer response is not JSON')
  }
  const text = await readBody(
    response,
    response.ok ? maxBytes : Math.min(maxBytes, MAX_ERROR_SNIPPET_BYTES),
    !response.ok
  )
  if (!response.ok) {
    const snippet = new TextDecoder().decode(
      new TextEncoder().encode(text).slice(0, MAX_ERROR_SNIPPET_BYTES)
    )
    throw new Error(`Overlay peer returned HTTP ${response.status}: ${JSON.stringify(snippet)}`)
  }
  if (text.length === 0) throw new TypeError('Overlay peer returned an empty JSON response')
  try {
    return JSON.parse(text)
  } catch {
    throw new TypeError('Overlay peer returned malformed JSON')
  }
}

export function assertGASPInitialResponse(
  value: unknown,
  maxOutputs: number
): asserts value is {
  UTXOList: Array<{ txid: string; outputIndex: number; score: number }>
  since: number
} {
  if (!isRecord(value) || !Array.isArray(value.UTXOList) || value.UTXOList.length > maxOutputs) {
    throw new TypeError('Invalid GASP initial response')
  }
  assertNonnegativeInteger(value.since, 'GASP response since')
  const seen = new Set<string>()
  for (const [index, item] of value.UTXOList.entries()) {
    if (!isRecord(item)) throw new TypeError(`GASP UTXOList[${index}] is invalid`)
    assertHash(item.txid, `GASP UTXOList[${index}].txid`)
    assertOutputIndex(item.outputIndex, `GASP UTXOList[${index}].outputIndex`)
    assertNonnegativeInteger(item.score, `GASP UTXOList[${index}].score`)
    const outpoint = `${item.txid.toLowerCase()}.${item.outputIndex}`
    if (seen.has(outpoint))
      throw new TypeError('GASP initial response contains duplicate outpoints')
    seen.add(outpoint)
  }
}

export function assertGASPNode(
  value: unknown,
  expected: { graphID: string; txid: string; outputIndex: number }
): asserts value is {
  graphID: string
  rawTx: string
  outputIndex: number
  proof?: string
  txMetadata?: string
  outputMetadata?: string
  inputs?: Record<string, { hash: string }>
} {
  if (!isRecord(value)) throw new TypeError('Invalid GASP node response')
  assertOutpoint(value.graphID, 'GASP node graphID')
  if (value.graphID !== expected.graphID)
    throw new TypeError('GASP node graphID does not match the request')
  assertOutputIndex(value.outputIndex, 'GASP node outputIndex')
  if (value.outputIndex !== expected.outputIndex) {
    throw new TypeError('GASP node outputIndex does not match the request')
  }
  assertHexBytes(value.rawTx, 'GASP node rawTx', MAX_RAW_TRANSACTION_BYTES)
  let actualTxid: string
  try {
    actualTxid = Transaction.fromHex(value.rawTx).id('hex')
  } catch {
    throw new TypeError('GASP node rawTx is not a valid transaction')
  }
  if (actualTxid.toLowerCase() !== expected.txid.toLowerCase()) {
    throw new TypeError('GASP node transaction does not match the requested txid')
  }
  for (const field of ['proof', 'txMetadata', 'outputMetadata'] as const) {
    if (value[field] !== undefined) {
      assertHexBytes(
        value[field],
        `GASP node ${field}`,
        field === 'proof' ? MAX_RAW_TRANSACTION_BYTES : MAX_METADATA_BYTES,
        true
      )
    }
  }
  if (value.inputs !== undefined) {
    if (!isRecord(value.inputs) || Object.keys(value.inputs).length > MAX_GASP_INPUTS) {
      throw new TypeError('GASP node inputs are invalid')
    }
    for (const [outpoint, metadata] of Object.entries(value.inputs)) {
      assertOutpoint(outpoint, 'GASP node input outpoint')
      if (!isRecord(metadata)) throw new TypeError('GASP node input metadata is invalid')
      assertHash(metadata.hash, 'GASP node input metadata hash')
    }
  }
}

export function assertRawTransactionMatches(txid: string, rawTx: string): void {
  assertHash(txid, 'transaction txid')
  assertHexBytes(rawTx, 'raw transaction', MAX_RAW_TRANSACTION_BYTES)
  let actual: string
  try {
    actual = Transaction.fromHex(rawTx).id('hex')
  } catch {
    throw new TypeError('Peer returned an invalid raw transaction')
  }
  if (actual.toLowerCase() !== txid.toLowerCase()) {
    throw new TypeError('Peer raw transaction does not match its txid')
  }
}
