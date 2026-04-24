import { Storage } from '@google-cloud/storage'
import { Request, Response } from 'express'
import { getWallet } from '../utils/walletSingleton'
import { Utils } from '@bsv/sdk'

interface ListRequest extends Request {
  auth: {
    identityKey: string
  }
  body: {
    limit: number
    offset: number
  }
}

interface ListResponse {
  status: 'success' | 'error'
  uploads?: Array<{
    uhrpUrl: string
    expiryTime: number
  }>
  code?: string
  description?: string
}

const listHandler = async (req: ListRequest, res: Response<ListResponse>) => {
  try {
    const identityKey = req.auth.identityKey
    if (!identityKey) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_MISSING_IDENTITY_KEY',
        description: 'Missing authfetch identityKey.'
      })
    }

    const wallet = await getWallet()

    const { limit = 200, offset = 0 } = req.body

    const { outputs } = await wallet.listOutputs({
      basket: 'uhrp advertisements',
      tags: [`uploader_identity_key_${identityKey}`],
      includeTags: true,
      tagQueryMode: 'all',
      limit,
      offset
    })
    const result: ListResponse['uploads'] = []

    for (const out of outputs) {
      if (!out.tags) continue

      const uhrpUrlTag = out.tags.find(t => t.startsWith('uhrp_url_'))
      const expiryTimeTag = out.tags.find(t => t.startsWith('expiry_time_'))

      const uhrpUrl = uhrpUrlTag
        ? Utils.toUTF8(Utils.toArray(uhrpUrlTag.substring('uhrp_url_'.length), 'hex'))
        : ''

      const expiryTime = expiryTimeTag
        ? parseInt(expiryTimeTag.substring('expiry_time_'.length), 10)
        : 0

      if (Date.now() > expiryTime * 1000) {
        continue
      }

      result.push({
        uhrpUrl,
        expiryTime
      })
    }

    return res.status(200).json({
      status: 'success',
      uploads: result
    })
  } catch (error) {
    console.error('[list] error:', error)
    return res.status(500).json({
      status: 'error',
      code: 'ERR_LIST',
      description: 'Error listing user-uploaded advertisements.'
    })
  }
}

export default {
  type: 'get',
  path: '/list',
  summary: 'Lists all UHRP files (advertisements) matching the user\'s identityKey in transaction tags.',
  parameters: {},
  exampleResponse: {
    status: 'success',
    uploads: [
      {

        uhrpUrl: 'uhrp://abcd1234...',
        expiryTime: 1691234567
      }
    ]
  },
  errors: ['ERR_LIST'],
  func: listHandler
}