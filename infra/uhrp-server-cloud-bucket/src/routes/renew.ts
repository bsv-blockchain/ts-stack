import { Request, Response } from 'express'
import { extendObjectRetention } from '../utils/extendObjectRetention'
import { createGoogleCloudStorage } from '../utils/googleCloudStorage'
import { PublicKey, PushDrop, SHIPBroadcaster, StorageUtils, Utils } from '@bsv/sdk'
import getPriceForFile from '../utils/getPriceForFile'
import { getWallet } from '../utils/walletSingleton'
import { log } from '../logger'
import { normalizeUhrpPagination } from '../resourceLimits'
import { readResourceLimit } from '../security/edgePolicy'
import { uhrpNetwork } from '../utils/network'
import { getChirpStore } from '../chirp/store'
import { advertisementTags, createAdvertisementMetadata } from '../utils/advertisementMetadata'
import { completeUhrpAction } from '../utils/completeUhrpAction'
import {
  listVerifiedAdvertisements,
  type VerifiedStoredAdvertisement
} from '../utils/storedAdvertisements'
import { decodeAndVerifyUHRPAdvertisement } from '../utils/uhrpTokenValidation'

const storage = createGoogleCloudStorage()
const GCP_BUCKET_NAME = process.env.GCP_BUCKET_NAME as string
const { lookupPreset } = uhrpNetwork()

interface RenewRequest extends Request {
  auth: { identityKey: string }
  body: { uhrpUrl: string; additionalMinutes: number; limit?: number; offset?: number }
}

interface RenewResponse {
  status: 'success' | 'error'
  newExpiryTime?: number
  prevExpiryTime?: number
  amount?: number
  code?: string
  description?: string
}

function farthest(values: VerifiedStoredAdvertisement[]): VerifiedStoredAdvertisement | undefined {
  return values.reduce<VerifiedStoredAdvertisement | undefined>(
    (current, candidate) =>
      current == null || candidate.metadata.expiryTime > current.metadata.expiryTime
        ? candidate
        : current,
    undefined
  )
}

const renewHandler = async (req: RenewRequest, res: Response<RenewResponse>) => {
  try {
    const identityKey = req.auth?.identityKey
    if (typeof identityKey !== 'string' || identityKey === 'unknown') {
      return res.status(400).json({ status: 'error', code: 'ERR_MISSING_IDENTITY_KEY', description: 'Missing authfetch identityKey.' })
    }
    if (!/^(?:02|03)[0-9a-f]{64}$/i.test(identityKey)) {
      return res.status(400).json({ status: 'error', code: 'ERR_INVALID_IDENTITY_KEY', description: 'The authenticated identity key is invalid.' })
    }
    PublicKey.fromString(identityKey)
    const { uhrpUrl: requestedUrl, additionalMinutes, limit, offset } = req.body ?? {}
    if (typeof requestedUrl !== 'string' || additionalMinutes === undefined) {
      return res.status(400).json({ status: 'error', code: 'ERR_MISSING_FIELDS', description: 'Missing uhrpUrl or additionalMinutes.' })
    }
    let uhrpUrl: string
    try { uhrpUrl = StorageUtils.getURLForHash(StorageUtils.getHashFromURL(requestedUrl)) } catch {
      return res.status(400).json({ status: 'error', code: 'ERR_INVALID_UHRP_URL', description: 'The UHRP URL is invalid.' })
    }
    const maximum = readResourceLimit('UHRP', 'MAX_RETENTION_MINUTES', 525_600)
    if (
      !Number.isSafeInteger(additionalMinutes) || additionalMinutes <= 0 ||
      (maximum !== -1 && additionalMinutes > maximum)
    ) return res.status(400).json({ status: 'error', code: 'ERR_INVALID_TIME', description: 'Additional Minutes must be a positive integer' })

    const pagination = normalizeUhrpPagination(limit, offset)
    const wallet = await getWallet()
    const { advertisements, BEEF } = await listVerifiedAdvertisements({
      uhrpUrl, uploaderIdentityKey: identityKey, ...pagination
    })
    const previous = farthest(advertisements)
    if (previous == null || BEEF == null) {
      return res.status(404).json({ status: 'error', code: 'ERR_OLD_ADVERTISEMENT_NOT_FOUND', description: `Couldn't find an authenticated old advertisement for ${uhrpUrl}` })
    }
    if (Date.now() > previous.metadata.expiryTime * 1000) {
      return res.status(410).json({ status: 'error', code: 'ERR_ADVERTISEMENT_EXPIRED', description: `The advertisement for ${uhrpUrl} has expired` })
    }
    const identifier = previous.metadata.objectIdentifier
    const isChirpRoot = new URL(previous.metadata.hostedFileLocation).pathname ===
      `/chirp/v1/${identifier}/objects/${identifier}`
    const objectFile = storage.bucket(GCP_BUCKET_NAME).file(
      isChirpRoot ? `chirp/v1/objects/${identifier}` : `cdn/${identifier}`
    )
    const [gcsMetadata] = await objectFile.getMetadata()
    const gcsSize = typeof gcsMetadata.size === 'string' ? Number(gcsMetadata.size) : gcsMetadata.size
    if (!Number.isSafeInteger(gcsSize) || gcsSize !== previous.metadata.fileSize) {
      throw new Error('GCS object size does not match the authenticated advertisement')
    }
    const extensionSeconds = additionalMinutes * 60
    const newExpiryTime = previous.metadata.expiryTime + extensionSeconds
    if (!Number.isSafeInteger(extensionSeconds) || !Number.isSafeInteger(newExpiryTime)) {
      return res.status(400).json({ status: 'error', code: 'ERR_INVALID_TIME', description: 'Renewal expiry exceeds the supported range' })
    }
    const amount = await getPriceForFile({
      fileSize: previous.metadata.fileSize,
      retentionPeriod: additionalMinutes
    })
    const source = await decodeAndVerifyUHRPAdvertisement(previous.lockingScript)
    const pushdrop = new PushDrop(wallet)
    const newLockingScript = await pushdrop.lock(
      [
        Utils.toArray(source.hostIdentityKey, 'hex'), source.hash,
        Utils.toArray(source.hostedFileLocation, 'utf8'),
        new Utils.Writer().writeVarIntNum(newExpiryTime).toArray(),
        new Utils.Writer().writeVarIntNum(source.fileSize).toArray()
      ],
      [2, 'uhrp advertisement'], '1', 'anyone', true
    )
    const renewed = await decodeAndVerifyUHRPAdvertisement(newLockingScript)
    if (
      renewed.hostIdentityKey !== source.hostIdentityKey || Utils.toHex(renewed.hash) !== previous.metadata.hash ||
      renewed.hostedFileLocation !== previous.metadata.hostedFileLocation ||
      renewed.expiryTime !== newExpiryTime || renewed.fileSize !== previous.metadata.fileSize
    ) throw new Error('Wallet created a substituted renewed UHRP advertisement')
    const { customInstructions, metadata } = createAdvertisementMetadata({
      objectIdentifier: previous.metadata.objectIdentifier,
      uploaderIdentityKey: previous.metadata.uploaderIdentityKey,
      hostedFileLocation: previous.metadata.hostedFileLocation,
      hash: renewed.hash, expiryTime: newExpiryTime, fileSize: previous.metadata.fileSize,
      contentType: previous.metadata.contentType
    })
    const unlocker = pushdrop.unlock(
      [2, 'uhrp advertisement'], '1', 'anyone', 'all', false,
      previous.satoshis, previous.lockingScript
    )
    const transaction = await completeUhrpAction(
      wallet,
      {
        inputBEEF: BEEF,
        inputs: [{ outpoint: previous.outpoint, unlockingScriptLength: 74, inputDescription: 'Redeeming old advertisement' }],
        outputs: [{
          lockingScript: newLockingScript.toHex(), satoshis: 1,
          basket: 'uhrp advertisements', outputDescription: 'UHRP advertisement token (renewed)',
          tags: advertisementTags(metadata), customInstructions
        }],
        description: `Renew advertisement for uhrpUrl ${uhrpUrl}`,
        options: { randomizeOutputs: false }
      },
      { outpoint: previous.outpoint, sign: async (tx, inputIndex) => await unlocker.sign(tx, inputIndex) }
    )
    const txid = transaction.id('hex')
    if (transaction.outputs.filter(output =>
      output.satoshis === 1 && output.lockingScript.toHex() === newLockingScript.toHex()
    ).length !== 1) throw new Error('Wallet did not create exactly one renewed UHRP advertisement')

    if (isChirpRoot) {
      const extended = await getChirpStore().extendRootLease(identifier, newExpiryTime)
      if (!extended) throw new Error('CHIRP root lease is not active')
    } else {
      await extendObjectRetention(objectFile, newExpiryTime)
    }
    const result = await new SHIPBroadcaster(['tm_uhrp'], {
      networkPreset: lookupPreset as 'mainnet' | 'testnet'
    }).broadcast(transaction)
    if (result.status !== 'success' || result.txid.toLowerCase() !== txid) {
      return res.status(502).json({ status: 'error', code: 'ERR_ADVERTISEMENT_BROADCAST', description: 'The renewed advertisement was not accepted by the overlay.' })
    }
    return res.status(200).json({
      status: 'success', prevExpiryTime: previous.metadata.expiryTime,
      newExpiryTime, amount
    })
  } catch (error) {
    log.error({ operation: 'renew.handle', outcome: 'error', err: error }, 'Renew handler failed')
    return res.status(500).json({ status: 'error', code: 'ERR_INTERNAL_RENEW', description: 'An error occurred while handling the renewal.' })
  }
}

export default {
  type: 'post', path: '/renew', summary: 'Renews an authenticated UHRP advertisement.',
  parameters: { uhrpUrl: 'The UHRP URL', additionalMinutes: 'Number of minutes to extend' },
  exampleResponse: { status: 'success', newExpiryTime: 28921659000, prevExpiryTime: 28921599000, amount: 42 },
  errors: ['ERR_MISSING_FIELDS', 'ERR_INVALID_UHRP_URL', 'ERR_OLD_ADVERTISEMENT_NOT_FOUND', 'ERR_ADVERTISEMENT_BROADCAST', 'ERR_INTERNAL_RENEW'],
  func: renewHandler
}
