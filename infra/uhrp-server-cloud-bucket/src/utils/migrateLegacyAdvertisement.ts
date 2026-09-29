import { createHash } from 'node:crypto'
import { Beef, PrivateKey, PublicKey, Utils, type WalletInterface, type WalletOutput, type Transaction } from '@bsv/sdk'
import type { Bucket, FileMetadata } from '@google-cloud/storage'
import { advertisementTags, createAdvertisementMetadata, requireAdvertisementTags, verifyAdvertisementMetadata } from './advertisementMetadata'
import { decodeAndVerifyUHRPAdvertisement } from './uhrpTokenValidation'

interface MigrationOptions {
  wallet: WalletInterface
  bucket: Bucket
  output: WalletOutput
  BEEF: number[] | Uint8Array | Beef
  hostingOrigin: string
  apply?: boolean
}

type VerifiedToken = Awaited<ReturnType<typeof decodeAndVerifyUHRPAdvertisement>>

function sourceOutput(options: MigrationOptions) {
  const { output } = options
  const match = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/.exec(output.outpoint)
  if (match == null || output.spendable !== true || !Number.isSafeInteger(output.satoshis)) {
    throw new Error('Invalid legacy advertisement output')
  }
  const index = Number(match[2])
  if (!Number.isSafeInteger(index) || index > 0xffffffff) throw new Error('Invalid legacy advertisement output index')
  if (!(options.BEEF instanceof Beef) && (options.BEEF.length < 1 || options.BEEF.length > 256 * 1024 * 1024)) {
    throw new Error('Invalid legacy advertisement BEEF')
  }
  const beef = options.BEEF instanceof Beef ? options.BEEF : Beef.fromBinary(options.BEEF)
  const transaction = beef.findAtomicTransaction(match[1])
  const source = transaction?.outputs[index]
  if (transaction?.id('hex') !== match[1] || source == null || source.satoshis !== output.satoshis ||
      (output.lockingScript !== undefined && output.lockingScript.toLowerCase() !== source.lockingScript.toHex())) {
    throw new Error('Legacy advertisement output does not match its source transaction')
  }
  return { transaction, source, index }
}

async function verifiedToken(lockingScript: Parameters<typeof decodeAndVerifyUHRPAdvertisement>[0], hostingOrigin: string) {
  const token = await decodeAndVerifyUHRPAdvertisement(lockingScript)
  const serverKey = process.env.SERVER_PRIVATE_KEY
  if (typeof serverKey !== 'string' || !/^[0-9a-f]{64}$/i.test(serverKey) ||
      token.hostIdentityKey !== PrivateKey.fromHex(serverKey).toPublicKey().toString()) {
    throw new Error('Legacy advertisement belongs to another host')
  }
  const origin = new URL(hostingOrigin)
  const location = new URL(token.hostedFileLocation)
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '' ||
      origin.username !== '' || origin.password !== '' || location.origin !== origin.origin ||
      location.search !== '' || location.hash !== '' || !/^\/cdn\/[1-9A-HJ-NP-Za-km-z]{1,128}$/.test(location.pathname)) {
    throw new Error('Legacy advertisement does not use the configured object location')
  }
  return { token, location }
}

async function providerReceipt(bucket: Bucket, name: string, token: VerifiedToken) {
  const [before] = await bucket.file(name).getMetadata()
  const owner: unknown = before.metadata?.uploaderidentitykey
  if (typeof owner !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/i.test(owner)) {
    throw new Error('Legacy object has no valid provider ownership receipt')
  }
  const identityKey = PublicKey.fromString(owner).toString().toLowerCase()
  const size = Number(before.size)
  const retention = new Date(before.customTime ?? '').getTime()
  if (!Number.isSafeInteger(size) || size !== token.fileSize || !Number.isFinite(retention) || retention < token.expiryTime * 1000 ||
      typeof before.generation !== 'string' || !/^[1-9]\d*$/.test(before.generation) ||
      typeof before.metageneration !== 'string' || !/^[1-9]\d*$/.test(before.metageneration)) {
    throw new Error('Legacy object size, generation, or retention does not match the token')
  }
  return { before, identityKey }
}

async function verifyContent(bucket: Bucket, name: string, before: FileMetadata, token: VerifiedToken): Promise<void> {
  const digest = createHash('sha256')
  let bytes = 0
  const stream = bucket.file(name, { generation: before.generation }).createReadStream({ validation: 'crc32c' })
  const deadline = setTimeout(() => stream.destroy(new Error('Legacy object verification deadline exceeded')), 60_000)
  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > token.fileSize) throw new Error('Legacy object exceeds its advertised size')
      digest.update(chunk)
    }
  } finally {
    clearTimeout(deadline)
    stream.destroy()
  }
  if (bytes !== token.fileSize || digest.digest('hex') !== Utils.toHex(token.hash)) {
    throw new Error('Legacy object content does not match its advertised hash')
  }
  const [after] = await bucket.file(name).getMetadata()
  if (after.generation !== before.generation || after.metageneration !== before.metageneration) {
    throw new Error('Legacy object changed during verification')
  }
}

async function mergeOwnership(wallet: WalletInterface, transaction: Transaction, index: number, output: WalletOutput,
  customInstructions: string, metadata: ReturnType<typeof createAdvertisementMetadata>['metadata']): Promise<void> {
  const result = await wallet.internalizeAction({
    tx: transaction.toAtomicBEEF(),
    outputs: [{ outputIndex: index, protocol: 'basket insertion', insertionRemittance: {
      basket: 'uhrp advertisements', customInstructions, tags: advertisementTags(metadata)
    } }],
    description: 'Recover verified legacy UHRP ownership'
  })
  if (result?.accepted !== true) throw new Error('Wallet did not accept the legacy ownership migration')
  const check = await wallet.listOutputs({
    basket: 'uhrp advertisements', tags: [`object_identifier_${Utils.toHex(Utils.toArray(metadata.objectIdentifier, 'utf8'))}`],
    includeCustomInstructions: true, includeTags: true, limit: 10_000
  })
  const updated = check.outputs.find(candidate => candidate.outpoint === output.outpoint)
  if (updated?.customInstructions !== customInstructions || updated.spendable !== true || updated.satoshis !== output.satoshis) {
    throw new Error('Legacy ownership migration did not persist unchanged output state')
  }
  requireAdvertisementTags(updated.tags, metadata)
}

/**
 * Recover an existing advertisement without spending or rebroadcasting it.
 * Provider ownership, generation, content hash, size, retention, host signature,
 * and source output must agree before signing an ownership envelope.
 * Dry run is the default; an in-place merge requires an explicit apply flag.
 */
export async function migrateLegacyAdvertisement(options: MigrationOptions): Promise<'expired' | 'already-verified' | 'verified' | 'migrated'> {
  const { wallet, bucket, output } = options
  const { transaction, source, index } = sourceOutput(options)
  if (output.customInstructions != null) {
    const metadata = await verifyAdvertisementMetadata(output.customInstructions, source.lockingScript)
    requireAdvertisementTags(output.tags, metadata)
    return 'already-verified'
  }
  const { token, location } = await verifiedToken(source.lockingScript, options.hostingOrigin)
  if (token.expiryTime * 1000 <= Date.now()) return 'expired'
  const name = location.pathname.slice(1)
  const { before, identityKey } = await providerReceipt(bucket, name, token)
  await verifyContent(bucket, name, before, token)
  const { metadata, customInstructions } = createAdvertisementMetadata({
    objectIdentifier: name.slice('cdn/'.length), uploaderIdentityKey: identityKey,
    hostedFileLocation: token.hostedFileLocation, hash: token.hash,
    expiryTime: token.expiryTime, fileSize: token.fileSize,
    contentType: before.contentType || 'application/octet-stream'
  })
  requireAdvertisementTags(output.tags, metadata)
  await verifyAdvertisementMetadata(customInstructions, source.lockingScript)
  if (options.apply !== true) return 'verified'
  await mergeOwnership(wallet, transaction, index, output, customInstructions, metadata)
  return 'migrated'
}
