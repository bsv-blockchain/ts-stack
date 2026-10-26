import { FetchHttpClient, Transaction, WhatsOnChain, type HttpClient } from '@bsv/sdk'

const WOC_BASE_URL = 'https://api.whatsonchain.com/v1/bsv/main'
const MAX_WOC_RESPONSE_BYTES = 1024 * 1024
const MAX_WOC_UTXOS = 10_000
const MAX_SATOSHIS = 21e14
const MAX_BLOCK_HEIGHT = 0x7fffffff

export interface WocUtxo {
  tx_hash: string
  tx_pos: number
  value: number
  height?: number
}

export function createWocHttpClient(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)
): HttpClient {
  return new FetchHttpClient(fetchImplementation, {
    timeoutMs: 10_000,
    maxResponseBytes: MAX_WOC_RESPONSE_BYTES
  })
}

const httpClient = createWocHttpClient()

// This configured service is authoritative for the example's current chain and
// unspent view. The client still binds every response to its exact local query.
export const wocHeadersClient = new WhatsOnChain('main', { httpClient })

function ownDataProperties(value: unknown, label: string): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`WhatsOnChain returned an invalid ${label}`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some(property => property.get != null || property.set != null)
  ) {
    throw new Error(`WhatsOnChain returned an invalid ${label}`)
  }
  return descriptors
}

function ownValue(properties: Record<string, PropertyDescriptor>, name: string): unknown {
  const property = properties[name]
  if (property == null || !Object.prototype.hasOwnProperty.call(property, 'value')) return undefined
  return property.value
}

export function parseWocUtxos(value: unknown): WocUtxo[] {
  if (!Array.isArray(value) || value.length > MAX_WOC_UTXOS) {
    throw new Error('WhatsOnChain returned an invalid UTXO list')
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error('WhatsOnChain returned an invalid UTXO list')
    }
  }
  const seen = new Set<string>()
  return value.map(candidate => {
    const properties = ownDataProperties(candidate, 'UTXO')
    const keys = Object.keys(properties)
    if (
      keys.some(
        key => key !== 'tx_hash' && key !== 'tx_pos' && key !== 'value' && key !== 'height'
      ) ||
      !keys.includes('tx_hash') ||
      !keys.includes('tx_pos') ||
      !keys.includes('value')
    ) {
      throw new Error('WhatsOnChain returned an invalid UTXO')
    }
    const txHash = ownValue(properties, 'tx_hash')
    const outputIndex = ownValue(properties, 'tx_pos')
    const satoshis = ownValue(properties, 'value')
    const height = ownValue(properties, 'height')
    if (
      typeof txHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(txHash) ||
      !Number.isSafeInteger(outputIndex) ||
      (outputIndex as number) < 0 ||
      (outputIndex as number) > 0xffffffff ||
      !Number.isSafeInteger(satoshis) ||
      (satoshis as number) < 0 ||
      (satoshis as number) > MAX_SATOSHIS ||
      (height !== undefined &&
        (!Number.isSafeInteger(height) ||
          (height as number) < 0 ||
          (height as number) > MAX_BLOCK_HEIGHT))
    ) {
      throw new Error('WhatsOnChain returned an invalid UTXO')
    }
    const outpoint = `${txHash}:${String(outputIndex)}`
    if (seen.has(outpoint)) throw new Error('WhatsOnChain returned a duplicate UTXO')
    seen.add(outpoint)
    return {
      tx_hash: txHash,
      tx_pos: outputIndex as number,
      value: satoshis as number,
      ...(height === undefined ? {} : { height: height as number })
    }
  })
}

export function parseWocTransaction(value: unknown, expectedTxid: string): Transaction {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WOC_RESPONSE_BYTES ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    throw new Error('WhatsOnChain returned an invalid raw transaction')
  }
  let transaction: Transaction
  try {
    transaction = Transaction.fromHex(value)
  } catch {
    throw new Error('WhatsOnChain returned an invalid raw transaction')
  }
  if (transaction.toHex() !== value || transaction.id('hex') !== expectedTxid) {
    throw new Error('WhatsOnChain returned a transaction for another txid')
  }
  return transaction
}

export async function requestWocUtxos(
  address: string,
  client: HttpClient = httpClient
): Promise<WocUtxo[]> {
  const response = await client.request<unknown>(
    `${WOC_BASE_URL}/address/${encodeURIComponent(address)}/unspent`,
    { method: 'GET', headers: { accept: 'application/json' } }
  )
  if (!response.ok) throw new Error(`WhatsOnChain UTXO request failed: ${response.status}`)
  return parseWocUtxos(response.data)
}

export async function requestWocTransaction(
  txid: string,
  client: HttpClient = httpClient
): Promise<Transaction> {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('Invalid transaction id')
  const response = await client.request<unknown>(`${WOC_BASE_URL}/tx/${txid}/hex`, {
    method: 'GET',
    headers: { accept: 'text/plain' }
  })
  if (!response.ok) throw new Error(`WhatsOnChain transaction request failed: ${response.status}`)
  return parseWocTransaction(response.data, txid)
}
