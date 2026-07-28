import { PubKeyHex } from '@bsv/sdk'

/** Minimal encrypted notification metadata; message content stays in Message Box. */
export interface EncryptedNotificationPayload {
  title?: string // Optional unencrypted title for display
}

/** Optional payment hint attached to a notification. */
export interface NotificationPayment {
  amount: number // Satoshis
  recipient: PubKeyHex
}

// FCM configuration interface (adapted from Jackie's code)
export interface FCMPayload {
  title: string
  body: string
  icon?: string
  badge?: number
  data?: Record<string, string>
}

export interface SendNotificationResult {
  success: boolean
  messageId: string
}
