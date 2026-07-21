import type { Knex } from 'knex'
import { getFirebaseMessaging } from '../config/firebase.js'
import { Logger } from './logger.js'
import { PubKeyHex } from '@bsv/sdk'

export interface FCMPayload {
  title: string
  messageId: string
  originator?: string
}

export interface SendNotificationResult {
  success: boolean
  error?: string
}

export async function sendFCMNotification (
  knex: Knex,
  recipient: PubKeyHex,
  payload: FCMPayload
): Promise<SendNotificationResult> {
  try {
    Logger.log(`[DEBUG] Attempting to send FCM notification to ${recipient}`)
    Logger.log('[DEBUG] Payload:', payload)

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
          android: {
            priority: 'high',
            data: {
              messageId: payload.messageId,
              originator: payload.originator || 'unknown'
            }
          },
          apns: {
            headers: {
              'apns-push-type': 'alert',
              'apns-priority': '10'
            },
            payload: {
              aps: {
                'mutable-content': 1,
                alert: {
                  title: payload.title,
                  body: payload.messageId
                }
              },
              messageId: payload.messageId,
              originator: payload.originator ?? 'unknown'
            }
          }
        })

        await knex('device_registrations')
          .where('fcm_token', device.fcm_token)
          .update({
            last_used: new Date(),
            updated_at: new Date()
          })

        return { success: true, token: device.fcm_token }
      } catch (error) {
        Logger.error(`[FCM ERROR] Failed to send to token ${device.fcm_token.slice(-10)}:`, error)

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
