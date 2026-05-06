import knexConfig from '../../knexfile.js'
import * as knexLib from 'knex'
import { Logger } from './logger.js'
import { PubKeyHex } from '@bsv/sdk'

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
  try {
    const serverFee = await knex('server_fees')
      .where({ message_box: messageBox })
      .select('delivery_fee')
      .first()

    return serverFee?.delivery_fee ?? 0
  } catch (error) {
    Logger.error('[ERROR] Error getting server delivery fee:', error)
    return 0
  }
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
    // Debug parameter types
    Logger.log(`[DEBUG] getRecipientFee params - recipient: ${typeof recipient} (${JSON.stringify(recipient)}), sender: ${typeof sender} (${JSON.stringify(sender)}), messageBox: ${typeof messageBox} (${JSON.stringify(messageBox)})`)

    // First try sender-specific permission
    if (sender != null) {
      const senderSpecific = await knex('message_permissions')
        .where({
          recipient: String(recipient),
          sender: String(sender),
          message_box: String(messageBox)
        })
        .select('recipient_fee')
        .first()

      if (senderSpecific != null) {
        return senderSpecific.recipient_fee
      }
    }

    // Fallback to box-wide default
    const boxWideDefault = await knex('message_permissions')
      .where({
        recipient: String(recipient),
        sender: null, // Box-wide default
        message_box: String(messageBox)
      })
      .select('recipient_fee')
      .first()

    if (boxWideDefault != null) {
      return boxWideDefault.recipient_fee
    }

    // Auto-create box-wide default if none exists
    const defaultFee = getSmartDefaultFee(String(messageBox))
    await knex('message_permissions').insert({
      recipient: String(recipient),
      sender: null,
      message_box: String(messageBox),
      recipient_fee: defaultFee,
      created_at: new Date(),
      updated_at: new Date()
    })

    Logger.log(`[DEBUG] Created box-wide default permission for ${recipient}/${messageBox} with fee ${defaultFee}`)
    return defaultFee
  } catch (error) {
    Logger.error('[ERROR] Error getting recipient fee:', error)
    return 0 // Block on error
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
    await knex('message_permissions')
      .insert({
        recipient,
        sender,
        message_box: messageBox,
        recipient_fee: recipientFee,
        created_at: now,
        updated_at: now
      })
      .onConflict(['recipient', 'sender', 'message_box'])
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
