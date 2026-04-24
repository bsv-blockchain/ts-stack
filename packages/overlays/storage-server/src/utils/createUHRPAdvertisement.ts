import { PushDrop, PrivateKey, Transaction, StorageUtils, Utils, AtomicBEEF, SHIPBroadcaster } from "@bsv/sdk"
import { getWallet } from "./walletSingleton"
import { Setup } from "@bsv/wallet-toolbox"

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as string
const BSV_NETWORK = process.env.BSV_NETWORK as 'mainnet' | 'testnet'
const WALLET_STORAGE_URL = process.env.WALLET_STORAGE_URL as string

export interface AdvertisementParams {
  hash: number[]
  objectIdentifier: string
  expiryTime: number
  uploaderIdentityKey: string
  url: string
  contentLength: number
  confederacyHost?: string
}

export interface AdvertisementResponse {
  txid: string
}

export default async function createUHRPAdvertisement({
  hash,
  objectIdentifier,
  expiryTime,
  url,
  uploaderIdentityKey,
  contentLength
}: AdvertisementParams): Promise<AdvertisementResponse> {
  if (typeof hash === 'string') {
    hash = StorageUtils.getHashFromURL(hash)
  }

  const expiryTimeSeconds = Math.floor(expiryTime)
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
    chain: BSV_NETWORK === 'mainnet' ? 'main' : 'test',
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

  const uhrpURL = StorageUtils.getURLForHash(hash)

  const createResult = await wallet.createAction({
    outputs: [{
      lockingScript: lockingScript.toHex(),
      satoshis: 1,
      basket: 'uhrp advertisements',
      outputDescription: 'UHRP advertisement token',
      tags: [`uhrp_url_${Utils.toHex(Utils.toArray(uhrpURL, 'utf8'))}`, `object_identifier_${Utils.toHex(Utils.toArray(objectIdentifier, 'utf8'))}`, `uploader_identity_key_${uploaderIdentityKey}`, `expiry_time_${expiryTimeSeconds}`]
    }],
    description: 'UHRP Content Availability Advertisement',
    options: {
      randomizeOutputs: false
    }
  })
  const transaction = Transaction.fromAtomicBEEF(createResult.tx!)
  const txid = transaction.id('hex')
  const broadcaster = new SHIPBroadcaster(['tm_uhrp'], {
    networkPreset: BSV_NETWORK
  })
  await broadcaster.broadcast(transaction)

  return {
    txid
  }
}
