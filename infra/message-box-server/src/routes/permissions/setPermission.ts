import { Response } from 'express'
import { PublicKey } from '@bsv/sdk'
import { Logger } from '../../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { setMessagePermission } from '../../utils/messagePermissions.js'
import { isCanonicalMessageBox, MAX_MESSAGE_BOX_BYTES } from '../../security/messageFields.js'

export const MAX_PERMISSION_MESSAGE_BOX_BYTES = MAX_MESSAGE_BOX_BYTES
export const MAX_RECIPIENT_FEE = 2_147_483_647

export interface SetPermissionRequestType extends AuthRequest {
  body: {
    sender?: string // Optional - if not provided, sets box-wide default
    messageBox: string
    recipientFee: number
  }
}

const validRecipientFee = (recipientFee: number): boolean =>
  Number.isSafeInteger(recipientFee) && recipientFee >= -1 && recipientFee <= MAX_RECIPIENT_FEE

function permissionDescription(
  sender: string | undefined,
  messageBox: string,
  recipientFee: number
): string {
  const isBoxWide = sender == null
  const senderText = sender ?? 'all senders'
  const actionText = isBoxWide ? 'Box-wide default for' : 'Messages from'

  if (recipientFee === -1) {
    return `${actionText} ${senderText} to ${messageBox} ${isBoxWide ? 'is' : 'are'} now blocked.`
  }
  if (recipientFee === 0) {
    return `${actionText} ${senderText} to ${messageBox} ${isBoxWide ? 'is' : 'are'} now always allowed.`
  }
  return `${actionText} ${senderText} to ${messageBox} now require${isBoxWide ? 's' : ''} ${recipientFee} satoshis.`
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
 *                 maxLength: 128
 *                 description: Exact control-free messageBox type (e.g., 'notifications', 'inbox')
 *               recipientFee:
 *                 type: integer
 *                 minimum: -1
 *                 maximum: 2147483647
 *                 description: Fee level (-1=blocked, 0=always allow, >0=satoshi amount required). Success is returned only after persistence.
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
      let normalizedSender: string | undefined

      // Validate request body (sender is optional)
      if (messageBox == null || typeof recipientFee !== 'number') {
        Logger.log('[DEBUG] Invalid request body for set permission')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_REQUEST',
          description:
            'messageBox (string) and recipientFee (number) are required. sender (string) is optional for box-wide settings.'
        })
      }

      // Validate sender public key format only if provided
      if (sender != null) {
        try {
          normalizedSender = PublicKey.fromString(sender).toString()
        } catch {
          Logger.log('[DEBUG] Invalid sender public key format')
          return res.status(400).json({
            status: 'error',
            code: 'ERR_INVALID_PUBLIC_KEY',
            description: 'Invalid sender public key format.'
          })
        }
      }

      // Validate recipientFee value
      if (!validRecipientFee(recipientFee)) {
        Logger.log('[DEBUG] Invalid recipientFee value - must be integer')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_FEE_VALUE',
          description: `recipientFee must be -1, 0, or a positive integer no greater than ${MAX_RECIPIENT_FEE}.`
        })
      }

      // Validate messageBox value
      if (!isCanonicalMessageBox(messageBox)) {
        Logger.log('[DEBUG] Invalid messageBox value')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_MESSAGE_BOX',
          description: `messageBox must be an exact, control-free string of at most ${MAX_PERMISSION_MESSAGE_BOX_BYTES} bytes.`
        })
      }

      // Set the message permission (convert undefined sender to null for box-wide)
      const success = await setMessagePermission(
        recipient,
        normalizedSender ?? null,
        messageBox,
        recipientFee
      )

      if (success !== true) {
        return res.status(500).json({
          status: 'error',
          code: 'ERR_DATABASE_ERROR',
          description: 'Failed to update message permission.'
        })
      }

      Logger.log('[DEBUG] Successfully updated message permission.')

      return res.status(200).json({
        status: 'success',
        description: permissionDescription(normalizedSender, messageBox, recipientFee)
      })
    } catch {
      Logger.error('[ERROR] Internal Server Error in set permission.')
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}
