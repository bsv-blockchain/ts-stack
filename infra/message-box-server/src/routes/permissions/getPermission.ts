import { Response } from 'express'
import { PublicKey } from '@bsv/sdk'
import { Logger } from '../../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { runtimeDeps } from '../../runtimeDeps.js'
import { readStoredRecipientFee } from '../../utils/messagePermissions.js'
import { isCanonicalMessageBox, MAX_MESSAGE_BOX_BYTES } from '../../security/messageFields.js'

export interface GetPermissionRequest extends AuthRequest {
  query: {
    sender?: string // identityKey of sender to check
    messageBox?: string // messageBox type to check
  }
}

/**
 * @swagger
 * /permissions/get:
 *   get:
 *     summary: Get message permission for a sender/box combination
 *     description: Retrieve the permission setting for a specific sender and message box combination
 *     tags:
 *       - Permissions
 *     parameters:
 *       - in: query
 *         name: sender
 *         required: false
 *         schema:
 *           type: string
 *         description: identityKey of the sender to check (omit for box-wide default)
 *       - in: query
 *         name: messageBox
 *         required: true
 *         schema:
 *           type: string
 *           maxLength: 128
 *         description: Exact control-free messageBox type to check
 *     responses:
 *       200:
 *         description: Permission setting retrieved successfully (or null if not set)
 *       400:
 *         description: Invalid request parameters
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
export default {
  type: 'get',
  path: '/permissions/get',
  func: async (req: GetPermissionRequest, res: Response): Promise<Response> => {
    try {
      Logger.log('[DEBUG] Processing get message permission request')

      // Validate authentication
      if (req.auth?.identityKey == null) {
        Logger.log('[DEBUG] Authentication required for get permission')
        return res.status(401).json({
          status: 'error',
          code: 'ERR_AUTHENTICATION_REQUIRED',
          description: 'Authentication required.'
        })
      }

      const { sender, messageBox } = req.query
      let normalizedSender: string | undefined

      // Validate required parameters
      if (!isCanonicalMessageBox(messageBox)) {
        Logger.log('[DEBUG] Missing required parameters for get permission')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_MESSAGE_BOX',
          description: `messageBox must be an exact, control-free string of at most ${MAX_MESSAGE_BOX_BYTES} bytes.`
        })
      }

      // Validate sender public key format if provided
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

      const recipient = req.auth.identityKey
      const normalizedMessageBox = messageBox

      // Get message permission directly from database
      const whereClause = {
        recipient,
        message_box: normalizedMessageBox,
        sender_scope: normalizedSender ?? ''
      }

      const permission = await runtimeDeps
        .knex('message_permissions')
        .where(whereClause)
        .select('recipient_fee', 'created_at', 'updated_at')
        .first()

      Logger.log('[DEBUG] Permission lookup completed for authenticated recipient.')

      if (permission != null) {
        const recipientFee = readStoredRecipientFee(permission.recipient_fee)
        // Helper function to determine status from recipient fee
        const getStatusFromFee = (fee: number): 'always_allow' | 'blocked' | 'payment_required' => {
          if (fee === -1) return 'blocked'
          if (fee === 0) return 'always_allow'
          return 'payment_required'
        }

        // Permission is set, return it
        return res.status(200).json({
          status: 'success',
          description:
            normalizedSender != null
              ? `Permission setting found for sender ${normalizedSender} to ${normalizedMessageBox}.`
              : `Box-wide permission setting found for ${normalizedMessageBox}.`,
          permission: {
            sender: normalizedSender ?? null,
            messageBox: normalizedMessageBox,
            recipientFee,
            status: getStatusFromFee(recipientFee),
            createdAt: permission.created_at.toISOString(),
            updatedAt: permission.updated_at.toISOString()
          }
        })
      } else {
        // No permission set, return undefined
        return res.status(200).json({
          status: 'success',
          description:
            normalizedSender != null
              ? `No permission setting found for sender ${normalizedSender} to ${normalizedMessageBox}.`
              : `No box-wide permission setting found for ${normalizedMessageBox}.`,
          permission: null
        })
      }
    } catch {
      Logger.error('[ERROR] Internal Server Error in get permission.')
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}
