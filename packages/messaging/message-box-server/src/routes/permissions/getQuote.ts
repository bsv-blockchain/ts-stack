import { Response } from 'express'
import { PublicKey } from '@bsv/sdk'
import { Logger } from '../../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { getRecipientFee, getServerDeliveryFee } from '../../utils/messagePermissions.js'

export interface GetQuoteRequest extends AuthRequest {
  query: {
    recipient: string | string[] // identityKey of recipient or array of recipients
    messageBox?: string           // messageBox type
  }
}

/**
 * @swagger
 * /permissions/quote:
 *   get:
 *     summary: Get message delivery quote(s)
 *     description: Get pricing information for sending messages to one or many recipients' message boxes
 *     tags:
 *       - Permissions
 *     parameters:
 *       - in: query
 *         name: recipient
 *         required: true
 *         schema:
 *           oneOf:
 *             - type: string
 *             - type: array
 *               items:
 *                 type: string
 *         description: identityKey of the recipient, or multiple recipients by repeating the parameter (?recipient=A&recipient=B)
 *       - in: query
 *         name: messageBox
 *         required: true
 *         schema:
 *           type: string
 *         description: messageBox type
 *     responses:
 *       200:
 *         description: Quote(s) retrieved successfully
 *       400:
 *         description: Invalid request parameters
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
export default {
  type: 'get',
  path: '/permissions/quote',
  func: async (req: GetQuoteRequest, res: Response): Promise<Response> => {
    try {
      Logger.log('[DEBUG] Processing message quote request')
      console.log('[DEBUG] Processing message quote request')

      // Validate authentication (the caller is the SENDER)
      const sender = req.auth?.identityKey
      if (sender == null) {
        Logger.log('[DEBUG] Authentication required for message quote')
        return res.status(401).json({
          status: 'error',
          code: 'ERR_AUTHENTICATION_REQUIRED',
          description: 'Authentication required.'
        })
      }

      const { recipient, messageBox } = req.query

      // Required params
      if (recipient == null || messageBox == null) {
        Logger.log('[DEBUG] Missing required parameters for message quote')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_MISSING_PARAMETERS',
          description: 'recipient and messageBox parameters are required.'
        })
      }

      // Normalize recipients to array (preserve order)
      const recipients: string[] = Array.isArray(recipient) ? recipient : [recipient]

      if (recipients.length === 0) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_MISSING_PARAMETERS',
          description: 'At least one recipient is required.'
        })
      }

      // Validate each recipient public key
      const invalidIdx: number[] = []
      for (let i = 0; i < recipients.length; i++) {
        try {
          PublicKey.fromString(recipients[i])
        } catch {
          invalidIdx.push(i)
        }
      }
      if (invalidIdx.length > 0) {
        Logger.log('[DEBUG] Invalid recipient public key format in array')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_PUBLIC_KEY',
          description: `Invalid recipient public key at index(es): ${invalidIdx.join(', ')}.`
        })
      }

      // Delivery fee for this messageBox (applies per message/recipient)
      const perMessageDeliveryFee = await getServerDeliveryFee(messageBox)

      // Single-recipient path → keep legacy response shape for compatibility
      if (recipients.length === 1) {
        const recipientKey = recipients[0]
        const recipientFee = await getRecipientFee(recipientKey, sender, messageBox)

        return res.status(200).json({
          status: 'success',
          description: 'Message delivery quote generated.',
          quote: {
            deliveryFee: perMessageDeliveryFee,
            recipientFee
          }
        })
      }

      // Multi-recipient path → compute per-recipient, plus aggregates
      const quotesByRecipient: Array<{
        recipient: string
        messageBox: string
        deliveryFee: number
        recipientFee: number
        status: 'blocked' | 'always_allow' | 'payment_required'
      }> = []

      const blockedRecipients: string[] = []
      let totalRecipientFees = 0
      let totalDeliveryFees = 0

      // Helper to map fee -> status
      const feeToStatus = (fee: number): 'blocked' | 'always_allow' | 'payment_required' => {
        if (fee === -1) return 'blocked'
        if (fee === 0) return 'always_allow'
        return 'payment_required'
      }

      for (const r of recipients) {
        const recipientFee = await getRecipientFee(r, sender, messageBox)
        const status = feeToStatus(recipientFee)

        quotesByRecipient.push({
          recipient: r,
          messageBox,
          deliveryFee: perMessageDeliveryFee,
          recipientFee,
          status
        })

        // Aggregate: count deliveryFee per intended message, and recipientFee if not blocked
        totalDeliveryFees += perMessageDeliveryFee
        if (recipientFee === -1) {
          blockedRecipients.push(r)
        } else {
          totalRecipientFees += recipientFee
        }
      }

      const totals = {
        deliveryFees: totalDeliveryFees,
        recipientFees: totalRecipientFees,
        // If any are blocked, caller may want to handle those separately.
        // We still provide a full monetary total for non-blocked recipients:
        totalForPayableRecipients: totalDeliveryFees + totalRecipientFees
      }

      return res.status(200).json({
        status: 'success',
        description: `Message delivery quotes generated for ${recipients.length} recipients.`,
        quotesByRecipient,
        totals,
        blockedRecipients
      })
    } catch (error) {
      Logger.error('[ERROR] Internal Server Error in message quote:', error)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}