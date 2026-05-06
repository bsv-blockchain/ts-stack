import { Response } from 'express'
import knexConfig from '../../knexfile.js'
import * as knexLib from 'knex'
import { Logger } from '../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'

// Determine the environment (default to development)
const { NODE_ENV = 'development' } = process.env

/**
 * Knex instance connected based on environment (development, production, or staging).
 */
const knex: knexLib.Knex = (knexLib as any).default?.(
  NODE_ENV === 'production' || NODE_ENV === 'staging'
    ? knexConfig.production
    : knexConfig.development
) ?? (knexLib as any)(
  NODE_ENV === 'production' || NODE_ENV === 'staging'
    ? knexConfig.production
    : knexConfig.development
)

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
  func: async (req: AuthRequest, res: Response): Promise<Response> => {
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

      try {
        // Query devices for the authenticated user
        const devices = await knex('device_registrations')
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

        Logger.log(`[DEBUG] Found ${devices.length} registered devices for ${identityKey}`)

        return res.status(200).json({
          status: 'success',
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
