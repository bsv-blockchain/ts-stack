import path from 'path'
import { getWallet } from './walletSingleton'
import { Utils } from '@bsv/sdk'

const { HOSTING_DOMAIN } = process.env

interface UploadParams {
  size: number
  expiryTime: number
  objectIdentifier: string
  uploaderIdentityKey: string
}

interface UploadResponse {
  uploadURL: string
  requiredHeaders: Record<string, string>
}

export default async ({
  size,
  expiryTime,
  objectIdentifier,
  uploaderIdentityKey
}: UploadParams): Promise<UploadResponse> => {
  const wallet = await getWallet()
  const customTime = new Date((expiryTime + 300) * 1000).toISOString()

  // Generate the signed URL including the metadata headers.
  // The extensionHeaders are part of the signature and must be included by the client in the PUT request.
  const str = `fileSize=${size.toString()}&objectID=${objectIdentifier}&expiry=${customTime}&uploader=${uploaderIdentityKey}`
  const { hmac } = await wallet.createHmac({
    protocolID: [2, 'storage upload'],
    keyID: '1',
    data: Utils.toArray(str, 'utf8')
  })

  return {
    uploadURL: `${HOSTING_DOMAIN?.startsWith('localhost') ? 'http://' : 'https://'}${HOSTING_DOMAIN}/put?${str}&hmac=${Utils.toHex(hmac)}`,
    requiredHeaders: {}
  }
}
