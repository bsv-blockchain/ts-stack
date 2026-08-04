import { Request, Response } from 'express'
import { getMetadata } from '../utils/getMetadata'
import { log } from '../logger'
import { normalizeUhrpPagination } from '../resourceLimits'

interface FindRequest extends Request {
    auth: {
        identityKey: string
    }
    query: {
        uhrpUrl?: string
        limit?: string
        offset?: string
    }
    body: {
        limit?: number
        offset?: number
    }
}

interface FindResponse {
    status: 'success' | 'error'
    data?: {
        name: string
        size: string
        mimeType: string
        expiryTime: number
    }
    code?: string
    description?: string
}

const findHandler = async (req: FindRequest, res: Response<FindResponse>) => {
    try {
        const { identityKey } = req.auth
        if (!identityKey) {
            return res.status(400).json({
                status: 'error',
                code: 'ERR_MISSING_IDENTITY_KEY',
                description: 'Missing authfetch identityKey.'
            })
        }

        const { uhrpUrl } = req.query
        const pagination = normalizeUhrpPagination(
            req.body?.limit ?? req.query.limit,
            req.body?.offset ?? req.query.offset
        )
        if (!uhrpUrl) {
            return res.status(400).json({
                status: 'error',
                code: 'ERR_NO_UHRP_URL',
                description: 'You must provide a uhrpUrl query parameter'
            })
        }

        const {
            name,
            size,
            contentType,
            expiryTime
        } = await getMetadata(uhrpUrl, identityKey, pagination.limit, pagination.offset)

        return res.status(200).json({
            status: 'success',
            data: {
                name,
                size,
                mimeType: contentType,
                expiryTime
            }
        })
    } catch (error) {
        if (error instanceof RangeError) {
            return res.status(400).json({ status: 'error', code: 'ERR_INVALID_PAGINATION', description: error.message })
        }
        log.error({ operation: 'find.handle', outcome: 'error', err: error }, 'Find handler failed')
        return res.status(500).json({
            status: 'error',
            code: 'ERR_FIND',
            description: 'An error occurred while retrieving the file from uhrpUrl.'
        })
    }
}

export default {
    type: 'get',
    path: '/find',
    summary: 'Finds metadata for the file matching a given uhrpUrl',
    parameters: {
        uhrpUrl: 'The UHRP URL, e.g. ?uhrpUrl=uhrp://some-hash'
    },
    exampleResponse: {
        status: 'success',
        data: {
            name: 'cdn/abc123',
            size: '4096',
            mimeType: 'application/octet-stream',
            expiryTime: '2025-04-03T14:00:00Z'
        }
    },
    errors: ['ERR_NO_UHRP_URL', 'ERR_NOT_FOUND', 'ERR_FIND'],
    func: findHandler
}
