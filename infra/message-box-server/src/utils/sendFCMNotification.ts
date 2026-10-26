import { getFirebaseMessaging } from '../config/firebase.js'
import { Logger } from './logger.js'
import { PubKeyHex } from '@bsv/sdk'
import { runtimeDeps } from '../runtimeDeps.js'
import { readMessageBoxResourceConfig } from '../config/resources.js'
import { mapWithConcurrency } from './boundedConcurrency.js'
import type { Message } from 'firebase-admin/messaging'

const GENERIC_NOTIFICATION_BODY = 'Open the app to view this message.'

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

export function buildFCMMessage(token: string, payload: FCMPayload): Message {
  return {
    token,
    notification: {
      title: payload.title,
      body: GENERIC_NOTIFICATION_BODY
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
            body: GENERIC_NOTIFICATION_BODY
          }
        },
        messageId: payload.messageId,
        originator: payload.originator ?? 'unknown'
      }
    }
  }
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
    Logger.log('[DEBUG] Attempting to send FCM notification.')

    // Look up all active FCM tokens for this recipient
    const deviceQuery = runtimeDeps
      .knex('device_registrations')
      .where({
        identity_key: recipient,
        active: true
      })
      .select('fcm_token')
      .orderBy('updated_at', 'desc')
    const resources = readMessageBoxResourceConfig()
    const maxNotificationDevices = resources.maxNotificationDevices
    if (maxNotificationDevices !== -1) deviceQuery.limit(maxNotificationDevices)
    const deviceRegistrations = await deviceQuery

    if (deviceRegistrations.length === 0) {
      Logger.log('[DEBUG] No active FCM tokens found for recipient.')
      return { success: false, error: 'No registered devices found for recipient' }
    }

    Logger.log('[DEBUG] Found active registered devices.')

    // Send notification to all registered devices
    const results = await mapWithConcurrency(
      deviceRegistrations,
      resources.fcmSendConcurrency,
      async device => {
        try {
          Logger.log('[DEBUG] Sending FCM notification to a registered device.')

          const messaging = getFirebaseMessaging()
          if (messaging == null) {
            return {
              success: false,
              token: device.fcm_token,
              error: 'Firebase Messaging not initialized (ENABLE_FIREBASE != true)'
            }
          }

          await messaging.send(buildFCMMessage(device.fcm_token, payload))

          // Update last_used timestamp on successful send
          await runtimeDeps
            .knex('device_registrations')
            .where('fcm_token', device.fcm_token)
            .update({
              last_used: new Date(),
              updated_at: new Date()
            })

          return { success: true }
        } catch (error) {
          Logger.error('[FCM ERROR] Failed to send to a registered device.')

          // Mark token as inactive if it's invalid
          if (
            error instanceof Error &&
            (error.message.includes('registration-token-not-registered') ||
              error.message.includes('invalid-registration-token'))
          ) {
            Logger.log('[DEBUG] Marking invalid FCM token as inactive.')
            await runtimeDeps
              .knex('device_registrations')
              .where('fcm_token', device.fcm_token)
              .update({
                active: false,
                updated_at: new Date()
              })
          }

          return {
            success: false,
            error: 'FCM delivery failed'
          }
        }
      }
    )
    const successCount = results.filter(r => r.success).length

    Logger.log('[DEBUG] FCM notification attempts completed.')

    // Consider it successful if at least one device received the notification
    if (successCount > 0) {
      return { success: true }
    } else {
      return { success: false, error: `Failed to send to all ${results.length} registered devices` }
    }
  } catch {
    Logger.error('[FCM ERROR] Failed to send FCM notification.')
    return { success: false, error: 'FCM notification failed' }
  }
}
