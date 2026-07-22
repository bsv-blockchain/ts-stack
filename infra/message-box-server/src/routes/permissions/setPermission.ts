import { Response } from 'express'
import { PublicKey } from '@bsv/sdk'
import { Logger } from '../../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { setMessagePermission } from '../../utils/messagePermissions.js'

export interface SetPermissionRequestType extends AuthRequest {
  body: {
    sender?: string // Optional - if not provided, sets box-wide default
    messageBox: string
    recipientFee: number
  }
}

/**
 * @swagger
 * /permissions/set:
 *   post:
 *     summary: Set message permission for a sender/box combination or box-wide default
 *     description: Set permission level for receiving messages. If sender is provided, sets permission for that specific sender. If sender is omitted, sets box-wide default for all senders.
 *     tags:
 *       - Permissions
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - messageBox
 *               - recipientFee
 *             properties:
 *               sender:
 *                 type: string
 *                 description: identityKey of the sender (optional - if omitted, sets box-wide default for all senders)
 *               messageBox:
 *                 type: string
 *                 description: messageBox type (e.g., 'notifications', 'inbox')
 *               recipientFee:
 *                 type: integer
 *                 description: Fee level (-1=blocked, 0=always allow, >0=satoshi amount required)
 *     responses:
 *       200:
 *         description: Permission successfully set/updated
 *       400:
 *         description: Invalid request data
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
export default {
  type: 'post',
  path: '/permissions/set',
  func: async (req: SetPermissionRequestType, res: Response): Promise<Response> => {
    try {
      Logger.log('[DEBUG] Processing set message permission request')

      // Validate authentication
      const recipient = req.auth?.identityKey
      if (recipient == null) {
        Logger.log('[DEBUG] Authentication required for set permission')
        return res.status(401).json({
          status: 'error',
          code: 'ERR_AUTHENTICATION_REQUIRED',
          description: 'Authentication required.'
        })
      }

      const { sender, messageBox, recipientFee } = req.body

      // Validate request body (sender is optional)
      if (messageBox == null || typeof recipientFee !== 'number') {
        Logger.log('[DEBUG] Invalid request body for set permission')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_REQUEST',
          description: 'messageBox (string) and recipientFee (number) are required. sender (string) is optional for box-wide settings.'
        })
      }

      // Validate sender public key format only if provided
      if (sender != null) {
        try {
          PublicKey.fromString(sender)
        } catch (error) {
          Logger.log('[DEBUG] Invalid sender public key format')
          return res.status(400).json({
            status: 'error',
            code: 'ERR_INVALID_PUBLIC_KEY',
            description: 'Invalid sender public key format.'
          })
        }
      }

      // Validate recipientFee value
      if (!Number.isInteger(recipientFee)) {
        Logger.log('[DEBUG] Invalid recipientFee value - must be integer')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_FEE_VALUE',
          description: 'recipientFee must be an integer (-1, 0, or positive number).'
        })
      }

      // Validate messageBox value
      if (typeof messageBox !== 'string' || messageBox.trim() === '') {
        Logger.log('[DEBUG] Invalid messageBox value')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_MESSAGE_BOX',
          description: 'messageBox must be a non-empty string.'
        })
      }

      // Set the message permission (convert undefined sender to null for box-wide)
      const success = await setMessagePermission(recipient, sender ?? null, messageBox, recipientFee)

      if (success == null) {
        return res.status(500).json({
          status: 'error',
          code: 'ERR_DATABASE_ERROR',
          description: 'Failed to update message permission.'
        })
      }

      const isBoxWide = sender == null
      Logger.log(`[DEBUG] Successfully updated message permission: ${sender ?? 'BOX-WIDE'} -> ${recipient} (${messageBox}), fee: ${recipientFee}`)

      let description: string
      const senderText = isBoxWide ? 'all senders' : sender
      const actionText = isBoxWide ? 'Box-wide default for' : 'Messages from'

      if (recipientFee === -1) {
        description = `${actionText} ${senderText} to ${messageBox} ${isBoxWide ? 'is' : 'are'} now blocked.`
      } else if (recipientFee === 0) {
        description = `${actionText} ${senderText} to ${messageBox} ${isBoxWide ? 'is' : 'are'} now always allowed.`
      } else {
        description = `${actionText} ${senderText} to ${messageBox} now require${isBoxWide ? 's' : ''} ${recipientFee} satoshis.`
      }

      return res.status(200).json({
        status: 'success',
        description
      })
    } catch (error) {
      Logger.error('[ERROR] Internal Server Error in set permission:', error)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}
