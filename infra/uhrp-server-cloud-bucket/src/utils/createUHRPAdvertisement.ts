import {
  PushDrop,
  PrivateKey,
  StorageUtils,
  Utils,
  SHIPBroadcaster,
  type BroadcastFailure,
  type BroadcastResponse
} from "@bsv/sdk"
import { Setup } from "@bsv/wallet-toolbox"
import { uhrpNetwork } from "./network"
import { advertisementTags, createAdvertisementMetadata } from './advertisementMetadata'
import { completeUhrpAction } from './completeUhrpAction'
import { decodeAndVerifyUHRPAdvertisement } from './uhrpTokenValidation'

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as string
const { chain, lookupPreset } = uhrpNetwork()
const WALLET_STORAGE_URL = process.env.WALLET_STORAGE_URL as string

export interface AdvertisementParams {
  hash: number[] | string
  objectIdentifier: string
  expiryTime: number
  uploaderIdentityKey: string
  url: string
  contentLength: number
  confederacyHost?: string
  contentType?: string
}

export interface AdvertisementResponse {
  txid: string
}

export interface AdvertisementSubmission extends AdvertisementResponse {
  broadcastResult: BroadcastResponse | BroadcastFailure
}

export async function createUHRPAdvertisementWithResult({
  hash,
  objectIdentifier,
  expiryTime,
  url,
  uploaderIdentityKey,
  contentLength,
  contentType
}: AdvertisementParams): Promise<AdvertisementSubmission> {
  if (typeof hash === 'string') {
    hash = StorageUtils.getHashFromURL(hash)
  }

  const expiryTimeSeconds = Math.floor(expiryTime)
  if (
    !Array.isArray(hash) || hash.length !== 32 ||
    hash.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
    !Number.isSafeInteger(expiryTimeSeconds) || expiryTimeSeconds < 1 ||
    !Number.isSafeInteger(contentLength) || contentLength < 1
  ) throw new Error('Invalid UHRP advertisement hash, expiry, or content length')
  const key = PrivateKey.fromHex(SERVER_PRIVATE_KEY)
  const serverPublicKey = key.toPublicKey().toString()

  // Comply with the UHRP Protocol
  const fields: number[][] = [
    // The identity key of the storage host
    Utils.toArray(serverPublicKey, 'hex'),
    // The hash of what they are hosting
    hash,
    // The URL where it can be found
    Utils.toArray(url, 'utf8'),
    // The UTC timestamp in seconds from 1970 as VarInt
    new Utils.Writer().writeVarIntNum(expiryTimeSeconds).toArray(),
    // The content length as VarInt
    new Utils.Writer().writeVarIntNum(contentLength).toArray()
  ]

  const wallet = await Setup.createWalletClientNoEnv({
    chain,
    rootKeyHex: SERVER_PRIVATE_KEY,
    storageUrl: WALLET_STORAGE_URL
  })
  const pushdrop = new PushDrop(wallet)

  const lockingScript = await pushdrop.lock(
    fields,
    [2, 'uhrp advertisement'],
    '1',
    'anyone',
    true
  )

  const decoded = await decodeAndVerifyUHRPAdvertisement(lockingScript)
  if (
    decoded.hostIdentityKey !== serverPublicKey.toLowerCase() ||
    Utils.toHex(decoded.hash) !== Utils.toHex(hash) || decoded.hostedFileLocation !== url ||
    decoded.expiryTime !== expiryTimeSeconds || decoded.fileSize !== contentLength
  ) throw new Error('Wallet created a substituted UHRP advertisement')
  const { customInstructions, metadata } = createAdvertisementMetadata({
    objectIdentifier, uploaderIdentityKey, hostedFileLocation: url, hash,
    expiryTime: expiryTimeSeconds, fileSize: contentLength,
    contentType: contentType || 'application/octet-stream'
  })
  const transaction = await completeUhrpAction(wallet, {
    outputs: [{
      lockingScript: lockingScript.toHex(),
      satoshis: 1,
      basket: 'uhrp advertisements',
      outputDescription: 'UHRP advertisement token',
      tags: advertisementTags(metadata),
      customInstructions
    }],
    description: 'UHRP Content Availability Advertisement',
    options: {
      randomizeOutputs: false
    }
  })
  const txid = transaction.id('hex')
  if (transaction.outputs.filter(output =>
    output.satoshis === 1 && output.lockingScript.toHex() === lockingScript.toHex()
  ).length !== 1) throw new Error('Wallet did not create exactly one requested UHRP advertisement')
  const broadcaster = new SHIPBroadcaster(['tm_uhrp'], {
    // Keep the service buildable against the last published SDK during the coordinated release.
    networkPreset: lookupPreset as 'mainnet' | 'testnet'
  })
  const broadcastResult = await broadcaster.broadcast(transaction)
  if (broadcastResult.status === 'success' && broadcastResult.txid.toLowerCase() !== txid) {
    throw new Error('Overlay acknowledged a different UHRP advertisement transaction')
  }

  return {
    txid,
    broadcastResult
  }
}

export default async function createUHRPAdvertisement(
  params: AdvertisementParams
): Promise<AdvertisementResponse> {
  const { txid, broadcastResult } = await createUHRPAdvertisementWithResult(params)
  if (broadcastResult.status !== 'success') {
    throw new Error(`UHRP advertisement was not accepted: ${broadcastResult.code}`)
  }
  return { txid }
}
