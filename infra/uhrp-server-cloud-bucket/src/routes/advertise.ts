import { Storage } from '@google-cloud/storage';
import createUHRPAdvertisement from '../utils/createUHRPAdvertisement';
import { Request, Response } from 'express';
import { StorageUtils } from '@bsv/sdk';
import { log } from '../logger';
import { timingSafeEqual } from 'node:crypto';

const {
  ADMIN_TOKEN,
  HOSTING_DOMAIN,
  GCP_BUCKET_NAME
} = process.env

const storage = new Storage()

interface AdvertiseRequest extends Request {
  body: {
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
  const authorization = req.get('authorization')
  const suppliedToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : ''
  const configuredToken = typeof ADMIN_TOKEN === 'string' ? ADMIN_TOKEN : ''
  const tokenValid = configuredToken.length >= 32 &&
    suppliedToken.length === configuredToken.length &&
    timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(configuredToken))
  if (!tokenValid) {
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
    log.error({ operation: 'advertise.handle', outcome: 'error', err: error }, 'Error processing advertisement')
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
    authorization: 'Bearer token in the Authorization header',
    uhrpUrl: 'The UHRP URL string to advertise',
    objectIdentifier: 'The ID of this contract',
    fileSize: 'The length of the file'
  },
  exampleResponse: { status: 'success' },
  errors: ['ERR_UNAUTHORIZED'],
  func: advertiseHandler
}
