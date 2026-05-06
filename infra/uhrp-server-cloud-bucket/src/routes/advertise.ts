import { Storage } from '@google-cloud/storage';
import createUHRPAdvertisement from '../utils/createUHRPAdvertisement';
import { Request, Response } from 'express';
import { StorageUtils } from '@bsv/sdk';

const {
  ADMIN_TOKEN,
  HOSTING_DOMAIN,
  GCP_BUCKET_NAME
} = process.env

const storage = new Storage()

interface AdvertiseRequest extends Request {
  body: {
    adminToken: string
    uhrpUrl: string
    uploaderIdentityKey: string
    objectIdentifier: string
    fileSize: number
    expiryTime: number
  }
}

interface AdvertiseResponse {
  status: 'success' | 'error';
  code?: string;
  description?: string;
}

const advertiseHandler = async (req: AdvertiseRequest, res: Response<AdvertiseResponse>) => {
  if (typeof ADMIN_TOKEN !== 'string' || ADMIN_TOKEN.length <= 10 || req.body.adminToken !== ADMIN_TOKEN) {
    return res.status(401).json({
      status: 'error',
      code: 'ERR_UNAUTHORIZED',
      description: 'Failed to advertise hosting commitment!'
    })
  }

  try {
    const expiryTime = Number(req.body.expiryTime) // in seconds
    
    await createUHRPAdvertisement({
      hash: StorageUtils.getHashFromURL(req.body.uhrpUrl),
      objectIdentifier: req.body.objectIdentifier,
      url: `${HOSTING_DOMAIN}/cdn/${req.body.objectIdentifier}`,
      uploaderIdentityKey: req.body.uploaderIdentityKey,
      expiryTime,
      contentLength: req.body.fileSize
    })

    const storageFile = storage
    .bucket(GCP_BUCKET_NAME as string)
    .file(`cdn/${req.body.objectIdentifier}`)
    
    await storageFile.setMetadata({
      customTime: new Date((expiryTime + 300) * 1000).toISOString()
    })

    res.status(200).json({ status: 'success' })
  } catch (error) {
    console.error('Error processing advertisement:', error)
    res.status(500).json({
      status: 'error',
      code: 'ERR_INTERNAL',
      description: 'An internal error occurred while processing the request.'
    })
  }
}

export default {
  type: 'post',
  path: '/advertise',
  summary: 'Administrative endpoint to trigger UHRP advertisements when new files are uploaded.',
  parameters: {
    adminToken: 'Server admin token',
    uhrpUrl: 'The UHRP URL string to advertise',
    objectIdentifier: 'The ID of this contract',
    fileSize: 'The length of the file'
  },
  exampleResponse: { status: 'success' },
  errors: ['ERR_UNAUTHORIZED'],
  func: advertiseHandler
}