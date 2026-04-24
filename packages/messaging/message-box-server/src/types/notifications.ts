import { PubKeyHex } from '@bsv/sdk'

// TODO: Determine payload structure for notifications
export interface EncryptedNotificationPayload {
  title?: string // Optional unencrypted title for display
}

// Optional payment structure
export interface NotificationPayment {
  amount: number // Satoshis
  recipient: PubKeyHex
  // TODO: Add more payment fields as needed for internalizeAction
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
