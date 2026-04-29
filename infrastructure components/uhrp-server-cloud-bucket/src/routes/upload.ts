import { Request, Response } from 'express'
import crypto from 'crypto'
import { Utils } from '@bsv/sdk'
import getPriceForFile from '../utils/getPriceForFile'
import getUploadURL from '../utils/getUploadURL'

const MIN_HOSTING_MINUTES = process.env.MIN_HOSTING_MINUTES

interface UploadRequest extends Request {
  body: {
    fileSize: number
    retentionPeriod: number
  }
  auth: {
    identityKey: string
  }
}

interface UploadResponse {
  status: 'success' | 'error'
  uploadURL?: string
  publicURL?: string
  requiredHeaders?: Record<string, string>
  amount?: number
  code?: string
  description?: string
}

export async function uploadHandler(req: UploadRequest, res: Response<UploadResponse>) {
  try {
    if (!req.auth.identityKey) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_MISSING_IDENTITY_KEY',
        description: 'Missing authfetch identityKey.'
      })
    }
    const { fileSize, retentionPeriod } = req.body

    if (!fileSize || !Number.isInteger(fileSize) || fileSize <= 0) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_INVALID_SIZE',
        description: 'The file size must be a positive integer.'
      })
    }
    if (!retentionPeriod) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_NO_RETENTION_PERIOD',
        description: 'You must specify the number of minutes to host the file.'
      })
    }
    const minHostingMinutes = Number(MIN_HOSTING_MINUTES) || 0
    if (retentionPeriod < minHostingMinutes) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_INVALID_RETENTION_PERIOD',
        description: `The retention period must be >= ${minHostingMinutes} minutes`
      })
    }

    if (fileSize > 11000000000) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_INVALID_SIZE',
        description: 'Max supported file size is 11000000000 bytes.'
      })
    }

    const amount = await getPriceForFile({ fileSize, retentionPeriod })
    const objectIdentifier = Utils.toBase58(Array.from(crypto.randomBytes(16)))

    const { uploadURL, requiredHeaders } = await getUploadURL({
      size: fileSize,
      objectIdentifier,
      uploaderIdentityKey: req.auth.identityKey,
      expiryTime: (retentionPeriod * 60) + Math.round(Date.now() / 1000)
    })
    console.log('upload URL', uploadURL)
    console.log('requiredHeaders', requiredHeaders)

    return res.status(200).json({
      status: 'success',
      uploadURL,
      requiredHeaders,
      amount,
      description: 'File can now be uploaded.'
    })
  } catch (error) {
    console.error('Upload route error:', error)
    return res.status(500).json({
      status: 'error',
      code: 'ERR_INTERNAL_UPLOAD',
      description: 'An internal error occurred while handling upload.'
    })
  }
}

export default {
  type: 'post',
  path: '/upload',
  summary: 'Returns an uploadURL and publicURL for file hosting.',
  parameters: {
    fileSize: 'Size of file in bytes',
    retentionPeriod: 'Number of minutes to host the file'
  },
  exampleResponse: {
    status: 'success',
    amount: 42,
    uploadURL: 'https://some-presigned-url...',
    requiredHeaders: { 'content-length': 1244 }
  },
  errors: [
    'ERR_INVALID_SIZE',
    'ERR_NO_RETENTION_PERIOD',
    'ERR_INTERNAL_UPLOAD'
  ],
  func: uploadHandler
}
