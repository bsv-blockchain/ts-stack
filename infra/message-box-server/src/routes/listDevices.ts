import { Response } from 'express'
import { Logger } from '../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { runtimeDeps } from '../runtimeDeps.js'

export const MAX_DEVICE_PAGE_SIZE = 100
export const MAX_DEVICE_OFFSET = 100_000

interface ListDevicesRequest extends AuthRequest {
  query: {
    limit?: string
    offset?: string
  }
}

export interface RegisteredDevice {
  id: number
  deviceId: string | null
  platform: string | null
  fcmToken: string
  active: boolean
  createdAt: string
  updatedAt: string
  lastUsed: string
}

export default {
  type: 'get',
  path: '/devices',
  func: async (req: ListDevicesRequest, res: Response): Promise<Response> => {
    try {
      Logger.log('[DEBUG] Processing list devices request')

      // Validate authentication
      const identityKey = req.auth?.identityKey
      if (identityKey == null) {
        Logger.log('[DEBUG] Authentication required for listing devices')
        return res.status(401).json({
          status: 'error',
          code: 'ERR_AUTHENTICATION_REQUIRED',
          description: 'Authentication required.'
        })
      }

      const limitValue = req.query?.limit
      const offsetValue = req.query?.offset
      const limit = limitValue == null ? MAX_DEVICE_PAGE_SIZE : Number(limitValue)
      const offset = offsetValue == null ? 0 : Number(offsetValue)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DEVICE_PAGE_SIZE) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_LIMIT',
          description: `limit must be an integer between 1 and ${MAX_DEVICE_PAGE_SIZE}.`
        })
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_DEVICE_OFFSET) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_OFFSET',
          description: `offset must be an integer between 0 and ${MAX_DEVICE_OFFSET}.`
        })
      }

      try {
        // Query devices for the authenticated user
        const devices = await runtimeDeps
          .knex('device_registrations')
          .select([
            'id',
            'device_id as deviceId',
            'platform',
            'fcm_token as fcmToken',
            'active',
            'created_at as createdAt',
            'updated_at as updatedAt',
            'last_used as lastUsed'
          ])
          .where('identity_key', identityKey)
          .orderBy('updated_at', 'desc')
          .limit(limit)
          .offset(offset)

        Logger.log(`[DEBUG] Found ${devices.length} registered devices for ${identityKey}`)

        return res.status(200).json({
          status: 'success',
          limit,
          offset,
          devices: devices.map(device => ({
            ...device,
            // Truncate FCM token for security (show only last 10 characters)
            fcmToken: `...${device.fcmToken.slice(-10)}`
          }))
        })
      } catch (dbError: any) {
        Logger.error('[ERROR] Database error during device listing:', dbError)
        return res.status(500).json({
          status: 'error',
          code: 'ERR_DATABASE_ERROR',
          description: 'Failed to retrieve devices.'
        })
      }
    } catch (error) {
      Logger.error('[ERROR] Internal Server Error in listDevices:', error)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}
