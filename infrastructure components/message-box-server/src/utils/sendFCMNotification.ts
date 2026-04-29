import { getFirebaseMessaging } from '../config/firebase.js'
import { Logger } from './logger.js'
import { PubKeyHex } from '@bsv/sdk'
import knexConfig from '../../knexfile.js'
import * as knexLib from 'knex'

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

/**
 * FCM Payload interface
 */
export interface FCMPayload {
  title: string
  messageId: string
  originator?: string
}

/**
 * FCM notification result
 */
export interface SendNotificationResult {
  success: boolean
  error?: string
}

/**
 * Send FCM push notification to all registered devices for a recipient
 * Looks up FCM tokens from device_registrations table and sends to all active devices
 */
export async function sendFCMNotification(
  recipient: PubKeyHex,
  payload: FCMPayload
): Promise<SendNotificationResult> {
  try {
    Logger.log(`[DEBUG] Attempting to send FCM notification to ${recipient}`)
    Logger.log('[DEBUG] Payload:', payload)

    // Look up all active FCM tokens for this recipient
    const deviceRegistrations = await knex('device_registrations')
      .where({
        identity_key: recipient,
        active: true
      })
      .select('fcm_token', 'platform', 'device_id')

    if (deviceRegistrations.length === 0) {
      Logger.log(`[DEBUG] No active FCM tokens found for recipient ${recipient}`)
      return { success: false, error: 'No registered devices found for recipient' }
    }

    Logger.log(`[DEBUG] Found ${deviceRegistrations.length} active device(s) for ${recipient}`)

    // Send notification to all registered devices
    const sendPromises = deviceRegistrations.map(async (device) => {
      try {
        Logger.log(`[DEBUG] Sending to ${device.platform ?? 'unknown'} device: ${device.device_id ?? 'unknown'}`)

        const messaging = getFirebaseMessaging()
        if (messaging == null) {
          return { success: false, token: device.fcm_token, error: 'Firebase Messaging not initialized (ENABLE_FIREBASE != true)' }
        }

        await messaging.send({
          token: device.fcm_token,
          notification: {
            title: payload.title,
            body: payload.messageId
          },
          // Android configuration for headless service
          android: {
            priority: 'high',
            data: {
              messageId: payload.messageId,
              originator: payload.originator || 'unknown'
            }
          },
          // iOS configuration for mutable content and Notification Service Extension
          apns: {
            headers: {
              'apns-push-type': 'alert', // required for iOS 13+
              'apns-priority': '10',     // deliver immediately
              // optional: 'apns-topic': '<your app bundle id>'  // FCM fills this automatically
            },
            payload: {
              aps: {
                'mutable-content': 1,
                alert: {                 // include an alert so NSE can modify it
                  title: payload.title,
                  body: payload.messageId,
                },
                // do NOT set 'content-available': 1 unless you also want background fetch
              },
              // custom keys your NSE can read:
              messageId: payload.messageId,
              originator: payload.originator ?? 'unknown',
            },
          },
        })

        // Update last_used timestamp on successful send
        await knex('device_registrations')
          .where('fcm_token', device.fcm_token)
          .update({
            last_used: new Date(),
            updated_at: new Date()
          })

        return { success: true, token: device.fcm_token }
      } catch (error) {
        Logger.error(`[FCM ERROR] Failed to send to token ${device.fcm_token.slice(-10)}:`, error)

        // Mark token as inactive if it's invalid
        if (error instanceof Error && (
          error.message.includes('registration-token-not-registered') ||
          error.message.includes('invalid-registration-token')
        )) {
          Logger.log(`[DEBUG] Marking invalid token as inactive: ...${device.fcm_token.slice(-10)}`)
          await knex('device_registrations')
            .where('fcm_token', device.fcm_token)
            .update({
              active: false,
              updated_at: new Date()
            })
        }

        return { success: false, token: device.fcm_token, error: error instanceof Error ? error.message : String(error) }
      }
    })

    const results = await Promise.all(sendPromises)
    const successCount = results.filter(r => r.success).length
    const failureCount = results.length - successCount

    Logger.log(`[DEBUG] FCM notification results: ${successCount} successful, ${failureCount} failed`)

    // Consider it successful if at least one device received the notification
    if (successCount > 0) {
      return { success: true }
    } else {
      return { success: false, error: `Failed to send to all ${results.length} registered devices` }
    }
  } catch (error) {
    Logger.error('[FCM ERROR] Failed to send FCM notification:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
