import type { Knex } from 'knex'
import { Logger } from './logger.js'
import { PubKeyHex } from '@bsv/sdk'

export interface FeeCalculationResult {
  delivery_fee: number
  recipient_fee: number
  total_cost: number
  allowed: boolean
  requires_payment: boolean
  blocked_reason?: string
}

export async function getServerDeliveryFee (knex: Knex, messageBox: string): Promise<number> {
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

export async function getRecipientFee (
  knex: Knex,
  recipient: PubKeyHex,
  sender: PubKeyHex | null,
  messageBox: string
): Promise<number> {
  try {
    Logger.log(`[DEBUG] getRecipientFee params - recipient: ${typeof recipient} (${JSON.stringify(recipient)}), sender: ${typeof sender} (${JSON.stringify(sender)}), messageBox: ${typeof messageBox} (${JSON.stringify(messageBox)})`)

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

    const boxWideDefault = await knex('message_permissions')
      .where({
        recipient: String(recipient),
        sender: null,
        message_box: String(messageBox)
      })
      .select('recipient_fee')
      .first()

    if (boxWideDefault != null) {
      return boxWideDefault.recipient_fee
    }

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
    return 0
  }
}

function getSmartDefaultFee (messageBox: string): number {
  if (messageBox === 'notifications') {
    return 10
  }
  return 0
}

export async function setMessagePermission (
  knex: Knex,
  recipient: PubKeyHex,
  sender: PubKeyHex | null,
  messageBox: string,
  recipientFee: number
): Promise<boolean> {
  try {
    const now = new Date()

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

export function shouldUseFCMDelivery (messageBox: string): boolean {
  return messageBox === 'notifications'
}
