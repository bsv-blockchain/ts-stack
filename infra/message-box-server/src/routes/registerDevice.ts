import { Response } from 'express'
import { Logger } from '../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { runtimeDeps } from '../runtimeDeps.js'
import { isExactBoundedText } from '../security/messageFields.js'

export const MAX_FCM_TOKEN_LENGTH = 500
export const MAX_DEVICE_ID_LENGTH = 255

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
 *                 maxLength: 500
 *                 description: Exact control-free Firebase Cloud Messaging token; surrounding whitespace is not normalized
 *               deviceId:
 *                 type: string
 *                 maxLength: 255
 *                 description: Optional exact control-free device identifier; surrounding whitespace is not normalized
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
 *       409:
 *         description: The FCM token is already registered to another authenticated identity
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
      if (!isExactBoundedText(fcmToken, MAX_FCM_TOKEN_LENGTH)) {
        Logger.log('[DEBUG] Invalid FCM token provided')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_FCM_TOKEN',
          description: `fcmToken must be an exact, control-free string of at most ${MAX_FCM_TOKEN_LENGTH} bytes.`
        })
      }

      const normalizedFcmToken = fcmToken

      if (deviceId != null && !isExactBoundedText(deviceId, MAX_DEVICE_ID_LENGTH)) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_DEVICE_ID',
          description: `deviceId must be an exact, control-free string of at most ${MAX_DEVICE_ID_LENGTH} bytes.`
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
        // A token is a credential-like delivery address. Never let one
        // authenticated identity silently take a token already owned by
        // another identity.
        const now = new Date()
        const existing = await runtimeDeps
          .knex('device_registrations')
          .select('id', 'identity_key')
          .where('fcm_token', normalizedFcmToken)
          .first()

        if (existing != null && existing.identity_key !== identityKey) {
          return res.status(409).json({
            status: 'error',
            code: 'ERR_DEVICE_TOKEN_ALREADY_REGISTERED',
            description: 'This device token is already registered to another identity.'
          })
        }

        const values = {
          device_id: deviceId ?? null,
          platform: platform ?? null,
          updated_at: now,
          active: true,
          last_used: now
        }

        let deviceRegistrationId: number
        if (existing != null) {
          await runtimeDeps.knex('device_registrations').where('id', existing.id).update(values)
          deviceRegistrationId = existing.id
        } else {
          const [insertedId] = await runtimeDeps.knex('device_registrations').insert({
            identity_key: identityKey,
            fcm_token: normalizedFcmToken,
            created_at: now,
            ...values
          })
          deviceRegistrationId = Number(insertedId)
        }

        Logger.log('[DEBUG] Device registered successfully for authenticated identity.')

        return res.status(200).json({
          status: 'success',
          message: 'Device registered successfully for push notifications',
          deviceId: deviceRegistrationId
        })
      } catch {
        Logger.error('[ERROR] Database error during device registration.')
        return res.status(500).json({
          status: 'error',
          code: 'ERR_DATABASE_ERROR',
          description: 'Failed to register device.'
        })
      }
    } catch {
      Logger.error('[ERROR] Internal Server Error in registerDevice.')
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}
