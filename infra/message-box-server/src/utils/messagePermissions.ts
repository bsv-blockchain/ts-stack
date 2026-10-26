import { Logger } from './logger.js'
import { PubKeyHex } from '@bsv/sdk'
import { runtimeDeps } from '../runtimeDeps.js'

export const MAX_MESSAGE_PERMISSION_FEE = 2_147_483_647

function storedMessageFee(value: unknown, field: string, allowBlocked: boolean): number {
  const minimum = allowBlocked ? -1 : 0
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > MAX_MESSAGE_PERMISSION_FEE
  ) {
    throw new TypeError(`Persisted ${field} is outside the supported fee range.`)
  }
  return value as number
}

export function readStoredRecipientFee(value: unknown): number {
  return storedMessageFee(value, 'recipient fee', true)
}

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

  return storedMessageFee(serverFee?.delivery_fee ?? 0, 'delivery fee', false)
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
        return readStoredRecipientFee(senderSpecific.recipient_fee)
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
      return readStoredRecipientFee(boxWideDefault.recipient_fee)
    }

    // Defaults are policy, not stored user preferences. Avoid inserting
    // implicit rows on a read path (which can race and create duplicate
    // box-wide NULL-sender rows in SQL databases).
    const defaultFee = getSmartDefaultFee(String(messageBox))
    return defaultFee
  } catch {
    Logger.error('[ERROR] Unable to read a valid recipient fee.')
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
    readStoredRecipientFee(recipientFee)
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
  } catch {
    Logger.error('[ERROR] Unable to persist the recipient permission.')
    return false
  }
}

/**
 * Check if FCM delivery should be used for this message box
 */
export function shouldUseFCMDelivery(messageBox: string): boolean {
  return messageBox === 'notifications'
}
