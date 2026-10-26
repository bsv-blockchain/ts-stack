import { Request, Response } from 'express'
import { log } from '../logger'
import { normalizeUhrpPagination } from '../resourceLimits'
import { listVerifiedAdvertisements } from '../utils/storedAdvertisements'

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
  if (!req.auth.identityKey || req.auth.identityKey === 'unknown') {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_MISSING_IDENTITY_KEY',
        description: 'Missing authfetch identityKey.'
      })
    }
  try {
    const identityKey = req.auth.identityKey
    if (!identityKey) {
      return res.status(400).json({
        status: 'error',
        code: 'ERR_MISSING_IDENTITY_KEY',
        description: 'Missing authfetch identityKey.'
      })
    }

    const { limit, offset } = normalizeUhrpPagination(
      req.body?.limit ?? req.query.limit,
      req.body?.offset ?? req.query.offset
    )

    const { advertisements } = await listVerifiedAdvertisements({
      uploaderIdentityKey: identityKey,
      limit,
      offset
    })
    const result: ListResponse['uploads'] = []

    for (const advertisement of advertisements) {
      if (Date.now() > advertisement.metadata.expiryTime * 1000) {
        continue
      }

      result.push({
        uhrpUrl: advertisement.metadata.uhrpUrl,
        expiryTime: advertisement.metadata.expiryTime
      })
    }

    return res.status(200).json({
      status: 'success',
      uploads: result
    })
  } catch (error) {
    if (error instanceof RangeError) {
      return res.status(400).json({ status: 'error', code: 'ERR_INVALID_PAGINATION', description: error.message })
    }
    log.error({ operation: 'list.handle', outcome: 'error', err: error }, 'Error listing advertisements')
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
