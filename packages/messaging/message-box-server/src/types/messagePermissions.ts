import { PubKeyHex } from '@bsv/sdk'

// Generalized message permission for any box/sender combination
export interface MessagePermission {
  id: number
  recipient: PubKeyHex // identityKey of permission owner
  sender: PubKeyHex | null // identityKey of sender (null for box-wide defaults)
  message_box: string // messageBox type (e.g., 'notifications', 'inbox', etc.)
  recipient_fee: number // -1 = block, 0 = free, >0 = satoshi amount required
  created_at: Date
  updated_at: Date
}

// Fee calculation result
export interface FeeCalculationResult {
  deliveryFee: number
  recipientFee: number
}
