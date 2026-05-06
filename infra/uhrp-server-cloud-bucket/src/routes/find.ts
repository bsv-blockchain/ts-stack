import { Request, Response } from 'express'
import { Storage } from '@google-cloud/storage'
import { getWallet } from '../utils/walletSingleton'
import { getMetadata } from '../utils/getMetadata'

const storage = new Storage()
const { GCP_BUCKET_NAME } = process.env

interface FindRequest extends Request {
    auth: {
        identityKey: string
    }
    query: {
        uhrpUrl?: string
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
        const { limit, offset } = req.body
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
        } = await getMetadata(uhrpUrl, identityKey, limit, offset)

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
        console.error('[findHandler] error:', error)
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