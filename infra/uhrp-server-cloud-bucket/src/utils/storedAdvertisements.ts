import { Beef, Utils, type LockingScript, type WalletOutput } from '@bsv/sdk'
import { getWallet } from './walletSingleton'
import {
  requireAdvertisementTags,
  verifyAdvertisementMetadata,
  type AdvertisementMetadata
} from './advertisementMetadata'

export interface VerifiedStoredAdvertisement {
  outpoint: string
  txid: string
  outputIndex: number
  satoshis: number
  lockingScript: LockingScript
  metadata: AdvertisementMetadata
  walletOutput: WalletOutput
}

function outpoint(value: unknown): { txid: string; outputIndex: number; value: string } {
  if (typeof value !== 'string') throw new Error('UHRP wallet outpoint is invalid')
  const match = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/i.exec(value)
  if (match == null) throw new Error('UHRP wallet outpoint is invalid')
  const outputIndex = Number(match[2])
  if (!Number.isSafeInteger(outputIndex) || outputIndex > 0xffffffff) throw new Error('UHRP wallet outpoint is invalid')
  const txid = match[1].toLowerCase()
  return { txid, outputIndex, value: `${txid}.${outputIndex}` }
}

function beef(value: unknown): number[] | Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length < 1 || value.length > 256 * 1024 * 1024) throw new Error('UHRP wallet BEEF is invalid')
    return value
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 256 * 1024 * 1024) {
    throw new Error('UHRP wallet BEEF is invalid')
  }
  for (const byte of value) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error('UHRP wallet BEEF is invalid')
  }
  return value as number[]
}

export async function listVerifiedAdvertisements(options: {
  uhrpUrl?: string
  uploaderIdentityKey?: string
  objectIdentifier?: string
  limit: number
  offset: number
}): Promise<{ advertisements: VerifiedStoredAdvertisement[]; BEEF?: number[] | Uint8Array; nextOffset?: number; legacyAdvertisementsPending: number }> {
  if (
    !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10_000 ||
    !Number.isSafeInteger(options.offset) || options.offset < 0
  ) throw new RangeError('Invalid UHRP wallet pagination')
  const tags: string[] = []
  if (options.uhrpUrl !== undefined) tags.push(`uhrp_url_${Utils.toHex(Utils.toArray(options.uhrpUrl, 'utf8'))}`)
  if (options.uploaderIdentityKey !== undefined) tags.push(`uploader_identity_key_${options.uploaderIdentityKey.toLowerCase()}`)
  if (options.objectIdentifier !== undefined) {
    tags.push(`object_identifier_${Utils.toHex(Utils.toArray(options.objectIdentifier, 'utf8'))}`)
  }
  const result = await (await getWallet()).listOutputs({
    basket: 'uhrp advertisements', tags, tagQueryMode: 'all', includeTags: true,
    includeCustomInstructions: true, include: 'entire transactions',
    limit: options.limit, offset: options.offset
  })
  if (
    result == null || !Array.isArray(result.outputs) || result.outputs.length > options.limit ||
    result.outputs.length > 10_000 || !Number.isSafeInteger(result.totalOutputs) ||
    result.totalOutputs < result.outputs.length
  ) throw new Error('Wallet returned a malformed UHRP output list')
  const nextOffset = options.offset + result.outputs.length < result.totalOutputs
    ? options.offset + result.outputs.length
    : undefined
  if (result.outputs.length === 0) return { advertisements: [], legacyAdvertisementsPending: 0 }
  // Parse the page once, rather than reparsing all dependencies for each output.
  const transactions = Beef.fromBinary(beef(result.BEEF))
  let legacyAdvertisementsPending = 0
  const inputBeef = beef(result.BEEF)
  const advertisements: VerifiedStoredAdvertisement[] = []
  const seen = new Set<string>()
  for (const walletOutput of result.outputs) {
    const parsed = outpoint(walletOutput.outpoint)
    if (walletOutput.outpoint.toLowerCase() !== parsed.value || seen.has(parsed.value)) {
      throw new Error('Wallet returned a duplicate or non-canonical UHRP outpoint')
    }
    seen.add(parsed.value)
    if (
      walletOutput.spendable !== true || !Number.isSafeInteger(walletOutput.satoshis) ||
      walletOutput.satoshis < 0 || walletOutput.satoshis > 21e14
    ) throw new Error('Wallet returned invalid UHRP output metadata')
    // An unsigned legacy row cannot establish ownership. Keep it out of
    // management results, but do not let it block verified rows on this page.
    if (walletOutput.customInstructions == null) {
      legacyAdvertisementsPending++
      continue
    }
    const transaction = transactions.findTxid(parsed.txid)?.tx
    if (transaction == null) throw new Error('UHRP wallet BEEF does not contain the listed transaction')
    if (transaction.id('hex').toLowerCase() !== parsed.txid) throw new Error('UHRP wallet BEEF does not contain the listed transaction')
    const sourceOutput = transaction.outputs[parsed.outputIndex]
    if (sourceOutput == null || sourceOutput.satoshis !== walletOutput.satoshis) {
      throw new Error('UHRP wallet output does not match its source transaction')
    }
    if (
      walletOutput.lockingScript !== undefined &&
      walletOutput.lockingScript.toLowerCase() !== sourceOutput.lockingScript.toHex().toLowerCase()
    ) throw new Error('UHRP wallet locking script does not match its source transaction')
    const metadata = await verifyAdvertisementMetadata(walletOutput.customInstructions, sourceOutput.lockingScript)
    requireAdvertisementTags(walletOutput.tags, metadata)
    if (
      (options.uhrpUrl !== undefined && metadata.uhrpUrl !== options.uhrpUrl) ||
      (options.uploaderIdentityKey !== undefined && metadata.uploaderIdentityKey !== options.uploaderIdentityKey.toLowerCase()) ||
      (options.objectIdentifier !== undefined && metadata.objectIdentifier !== options.objectIdentifier)
    ) throw new Error('UHRP wallet metadata does not match the requested selector')
    advertisements.push({
      outpoint: parsed.value, txid: parsed.txid, outputIndex: parsed.outputIndex,
      satoshis: sourceOutput.satoshis, lockingScript: sourceOutput.lockingScript,
      metadata, walletOutput
    })
  }
  return { advertisements, BEEF: inputBeef, nextOffset, legacyAdvertisementsPending }
}
