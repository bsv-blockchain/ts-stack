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

export interface RegisterDeviceRequest extends AuthRequest {
  body: {
    fcmToken: string
    deviceId?: string
    platform?: string // 'ios' | 'android' | 'web'
  }
}

/**
 * @swagger
 * /registerDevice:
 *   post:
 *     summary: Register device for push notifications
 *     description: Register a device's FCM token for receiving push notifications
 *     tags:
 *       - Device
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fcmToken
 *             properties:
 *               fcmToken:
 *                 type: string
 *                 description: Firebase Cloud Messaging token
 *               deviceId:
 *                 type: string
 *                 description: Optional device identifier
 *               platform:
 *                 type: string
 *                 description: Device platform (ios, android, web)
 *                 enum: [ios, android, web]
 *     responses:
 *       200:
 *         description: Device registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Device registered successfully
 *                 deviceId:
 *                   type: integer
 *                   description: Database ID of the registered device
 *       400:
 *         description: Invalid request parameters
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */

export default {
  type: 'post',
  path: '/registerDevice',
  func: async (req: RegisterDeviceRequest, res: Response): Promise<Response> => {
    try {
      Logger.log('[DEBUG] Processing device registration request')

      // Validate authentication
      const identityKey = req.auth?.identityKey
      if (identityKey == null) {
        Logger.log('[DEBUG] Authentication required for device registration')
        return res.status(401).json({
          status: 'error',
          code: 'ERR_AUTHENTICATION_REQUIRED',
          description: 'Authentication required.'
        })
      }

      const { fcmToken, deviceId, platform } = req.body

      // Validate required fields
      if (fcmToken == null || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
        Logger.log('[DEBUG] Invalid FCM token provided')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_FCM_TOKEN',
          description: 'fcmToken is required and must be a non-empty string.'
        })
      }

      // Validate platform if provided
      const validPlatforms = ['ios', 'android', 'web']
      if (platform != null && !validPlatforms.includes(platform)) {
        Logger.log('[DEBUG] Invalid platform provided')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_PLATFORM',
          description: 'platform must be one of: ios, android, web'
        })
      }

      try {
        // Insert or update device registration
        const now = new Date()
        const [deviceRegistrationId] = await knex('device_registrations')
          .insert({
            identity_key: identityKey,
            fcm_token: fcmToken.trim(),
            device_id: deviceId?.trim() ?? null,
            platform: platform ?? null,
            created_at: now,
            updated_at: now,
            active: true,
            last_used: now
          })
          .onConflict('fcm_token')
          .merge({
            identity_key: identityKey, // Update identity key in case token was reassigned
            device_id: deviceId?.trim() ?? null,
            platform: platform ?? null,
            updated_at: now,
            active: true,
            last_used: now
          })

        Logger.log(`[DEBUG] Device registered successfully: ${identityKey} with token ending in ...${fcmToken.slice(-10)}`)

        return res.status(200).json({
          status: 'success',
          message: 'Device registered successfully for push notifications',
          deviceId: deviceRegistrationId
        })
      } catch (dbError: any) {
        Logger.error('[ERROR] Database error during device registration:', dbError)
        return res.status(500).json({
          status: 'error',
          code: 'ERR_DATABASE_ERROR',
          description: 'Failed to register device.'
        })
      }
    } catch (error) {
      Logger.error('[ERROR] Internal Server Error in registerDevice:', error)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}
