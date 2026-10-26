import { Transaction, Utils, type LockingScript, type WalletOutput } from '@bsv/sdk'
import { getWallet } from './walletSingleton'
import {
  requireAdvertisementTags,
  verifyStoredAdvertisementMetadata,
  type AdvertisementMetadata,
  type AdvertisementMetadataSource
} from './advertisementMetadata'

const MAX_WALLET_BEEF_BYTES = 256 * 1024 * 1024
const MAX_WALLET_OUTPUTS = 10_000

export interface VerifiedStoredAdvertisement {
  outpoint: string
  txid: string
  outputIndex: number
  satoshis: number
  lockingScript: LockingScript
  metadata: AdvertisementMetadata
  metadataSource: AdvertisementMetadataSource
  walletOutput: WalletOutput
}

function canonicalOutpoint(value: unknown): { txid: string; outputIndex: number; value: string } {
  if (typeof value !== 'string') throw new Error('UHRP wallet outpoint is invalid')
  const match = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/i.exec(value)
  if (match == null) throw new Error('UHRP wallet outpoint is invalid')
  const outputIndex = Number(match[2])
  if (!Number.isSafeInteger(outputIndex) || outputIndex > 0xffffffff) {
    throw new Error('UHRP wallet outpoint is invalid')
  }
  const txid = match[1].toLowerCase()
  return { txid, outputIndex, value: `${txid}.${outputIndex}` }
}

function boundedBEEF(value: unknown): number[] | Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length < 1 || value.length > MAX_WALLET_BEEF_BYTES) {
      throw new Error('UHRP wallet BEEF is missing or oversized')
    }
    return value
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WALLET_BEEF_BYTES) {
    throw new Error('UHRP wallet BEEF is missing or oversized')
  }
  for (let index = 0; index < value.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      !Number.isInteger(value[index]) ||
      value[index] < 0 ||
      value[index] > 255
    ) {
      throw new Error('UHRP wallet BEEF is malformed')
    }
  }
  return value as number[]
}

export async function listVerifiedAdvertisements(options: {
  uhrpUrl?: string
  uploaderIdentityKey?: string
  objectIdentifier?: string
  limit: number
  offset: number
}): Promise<{ advertisements: VerifiedStoredAdvertisement[]; BEEF?: number[] | Uint8Array }> {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_WALLET_OUTPUTS ||
    !Number.isSafeInteger(options.offset) ||
    options.offset < 0
  ) {
    throw new RangeError('Invalid UHRP wallet pagination')
  }
  const tags: string[] = []
  if (options.uhrpUrl !== undefined) {
    tags.push(`uhrp_url_${Utils.toHex(Utils.toArray(options.uhrpUrl, 'utf8'))}`)
  }
  if (options.uploaderIdentityKey !== undefined) {
    tags.push(`uploader_identity_key_${options.uploaderIdentityKey.toLowerCase()}`)
  }
  if (options.objectIdentifier !== undefined) {
    tags.push(`object_identifier_${Utils.toHex(Utils.toArray(options.objectIdentifier, 'utf8'))}`)
  }

  const wallet = await getWallet()
  const result = await wallet.listOutputs({
    basket: 'uhrp advertisements',
    tags,
    tagQueryMode: 'all',
    includeTags: true,
    includeCustomInstructions: true,
    include: 'entire transactions',
    limit: options.limit,
    offset: options.offset
  })
  if (
    result == null ||
    !Array.isArray(result.outputs) ||
    result.outputs.length > options.limit ||
    result.outputs.length > MAX_WALLET_OUTPUTS ||
    !Number.isSafeInteger(result.totalOutputs) ||
    result.totalOutputs < result.outputs.length
  ) {
    throw new Error('Wallet returned a malformed UHRP output list')
  }
  if (result.outputs.length === 0) return { advertisements: [] }
  const beef = boundedBEEF(result.BEEF)
  const advertisements: VerifiedStoredAdvertisement[] = []
  const seen = new Set<string>()
  for (const walletOutput of result.outputs) {
    const outpoint = canonicalOutpoint(walletOutput.outpoint)
    if (walletOutput.outpoint.toLowerCase() !== outpoint.value || seen.has(outpoint.value)) {
      throw new Error('Wallet returned a duplicate or non-canonical UHRP outpoint')
    }
    seen.add(outpoint.value)
    if (
      walletOutput.spendable !== true ||
      !Number.isSafeInteger(walletOutput.satoshis) ||
      walletOutput.satoshis < 0 ||
      walletOutput.satoshis > 21e14
    ) {
      throw new Error('Wallet returned invalid UHRP output metadata')
    }
    const transaction = Transaction.fromBEEF(beef, outpoint.txid)
    if (transaction.id('hex').toLowerCase() !== outpoint.txid) {
      throw new Error('UHRP wallet BEEF does not contain the listed transaction')
    }
    const sourceOutput = transaction.outputs[outpoint.outputIndex]
    if (sourceOutput == null || sourceOutput.satoshis !== walletOutput.satoshis) {
      throw new Error('UHRP wallet output does not match its source transaction')
    }
    const sourceScriptHex = sourceOutput.lockingScript.toHex().toLowerCase()
    if (
      walletOutput.lockingScript !== undefined &&
      walletOutput.lockingScript.toLowerCase() !== sourceScriptHex
    ) {
      throw new Error('UHRP wallet locking script does not match its source transaction')
    }
    const verifiedMetadata = await verifyStoredAdvertisementMetadata(
      walletOutput.customInstructions,
      walletOutput.tags,
      sourceOutput.lockingScript
    )
    const { metadata, source: metadataSource } = verifiedMetadata
    if (metadataSource === 'signed') requireAdvertisementTags(walletOutput.tags, metadata)
    if (
      (options.uhrpUrl !== undefined && metadata.uhrpUrl !== options.uhrpUrl) ||
      (options.uploaderIdentityKey !== undefined &&
        metadata.uploaderIdentityKey !== options.uploaderIdentityKey.toLowerCase()) ||
      (options.objectIdentifier !== undefined &&
        metadata.objectIdentifier !== options.objectIdentifier)
    ) {
      throw new Error('UHRP wallet metadata does not match the requested selector')
    }
    advertisements.push({
      outpoint: outpoint.value,
      txid: outpoint.txid,
      outputIndex: outpoint.outputIndex,
      satoshis: sourceOutput.satoshis,
      lockingScript: sourceOutput.lockingScript,
      metadata,
      metadataSource,
      walletOutput
    })
  }
  return { advertisements, BEEF: beef }
}
