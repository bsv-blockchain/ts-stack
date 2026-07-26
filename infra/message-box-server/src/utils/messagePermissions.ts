import { Logger } from './logger.js'
import { PubKeyHex } from '@bsv/sdk'
import { runtimeDeps } from '../runtimeDeps.js'

/**
 * Fee calculation result structure
 */
export interface FeeCalculationResult {
  delivery_fee: number
  recipient_fee: number
  total_cost: number
  allowed: boolean
  requires_payment: boolean
  blocked_reason?: string
}

/**
 * Get server delivery fee for a message box type
 */
export async function getServerDeliveryFee(messageBox: string): Promise<number> {
  const serverFee = await runtimeDeps
    .knex('server_fees')
    .where({ message_box: messageBox })
    .select('delivery_fee')
    .first()

  return serverFee?.delivery_fee ?? 0
}

/**
 * Get recipient fee for a sender/messageBox combination with hierarchical fallback
 */
export async function getRecipientFee(
  recipient: PubKeyHex,
  sender: PubKeyHex | null,
  messageBox: string
): Promise<number> {
  try {
    // First try sender-specific permission
    if (sender != null) {
      const senderSpecific = await runtimeDeps
        .knex('message_permissions')
        .where({
          recipient: String(recipient),
          sender_scope: String(sender),
          message_box: String(messageBox)
        })
        .select('recipient_fee')
        .first()

      if (senderSpecific != null) {
        return senderSpecific.recipient_fee
      }
    }

    // Fallback to box-wide default
    const boxWideDefault = await runtimeDeps
      .knex('message_permissions')
      .where({
        recipient: String(recipient),
        sender_scope: '', // Box-wide default
        message_box: String(messageBox)
      })
      .select('recipient_fee')
      .first()

    if (boxWideDefault != null) {
      return boxWideDefault.recipient_fee
    }

    // Defaults are policy, not stored user preferences. Avoid inserting
    // implicit rows on a read path (which can race and create duplicate
    // box-wide NULL-sender rows in SQL databases).
    const defaultFee = getSmartDefaultFee(String(messageBox))
    return defaultFee
  } catch (error) {
    Logger.error('[ERROR] Error getting recipient fee:', error)
    throw new Error('Unable to determine recipient permission')
  }
}

/**
 * Get smart default fee based on message box type
 */
function getSmartDefaultFee(messageBox: string): number {
  // Notifications are premium service
  if (messageBox === 'notifications') {
    return 10 // 10 satoshis
  }

  // Other message boxes are always allowed by default
  return 0
}

/**
 * Set message permission for a sender/recipient/messageBox combination
 */
export async function setMessagePermission(
  recipient: PubKeyHex,
  sender: PubKeyHex | null,
  messageBox: string,
  recipientFee: number
): Promise<boolean> {
  try {
    const now = new Date()

    // Use upsert (insert or update)
    await runtimeDeps
      .knex('message_permissions')
      .insert({
        recipient,
        sender,
        sender_scope: sender ?? '',
        message_box: messageBox,
        recipient_fee: recipientFee,
        created_at: now,
        updated_at: now
      })
      .onConflict(['recipient', 'message_box', 'sender_scope'])
      .merge({
        recipient_fee: recipientFee,
        updated_at: now
      })

    return true
  } catch (error) {
    Logger.error('[ERROR] Error setting message permission:', error)
    return false
  }
}

/**
 * Check if FCM delivery should be used for this message box
 */
export function shouldUseFCMDelivery(messageBox: string): boolean {
  return messageBox === 'notifications'
}
