import { Response } from 'express'
import { PublicKey } from '@bsv/sdk'
import { Logger } from '../../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { runtimeDeps } from '../../runtimeDeps.js'

const MAX_MESSAGE_BOX_BYTES = 128

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
 *         description: messageBox type to check
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

      // Validate required parameters
      if (
        typeof messageBox !== 'string' ||
        messageBox.trim() === '' ||
        Buffer.byteLength(messageBox.trim(), 'utf8') > MAX_MESSAGE_BOX_BYTES
      ) {
        Logger.log('[DEBUG] Missing required parameters for get permission')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_MESSAGE_BOX',
          description: `messageBox must be a non-empty string of at most ${MAX_MESSAGE_BOX_BYTES} bytes.`
        })
      }

      // Validate sender public key format if provided
      if (sender != null) {
        try {
          PublicKey.fromString(sender)
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
      const normalizedMessageBox = messageBox.trim()

      // Get message permission directly from database
      const whereClause = {
        recipient,
        message_box: normalizedMessageBox,
        sender_scope: sender ?? ''
      }

      const permission = await runtimeDeps
        .knex('message_permissions')
        .where(whereClause)
        .select('recipient_fee', 'created_at', 'updated_at')
        .first()

      Logger.log(
        `[DEBUG] Permission record for ${sender ?? 'box-wide'} -> authenticated recipient ` +
          `(${normalizedMessageBox}): ${permission == null ? 'not found' : 'found'}`
      )

      if (permission != null) {
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
            sender != null
              ? `Permission setting found for sender ${sender} to ${normalizedMessageBox}.`
              : `Box-wide permission setting found for ${normalizedMessageBox}.`,
          permission: {
            sender: sender ?? null,
            messageBox: normalizedMessageBox,
            recipientFee: permission.recipient_fee,
            status: getStatusFromFee(permission.recipient_fee),
            createdAt: permission.created_at.toISOString(),
            updatedAt: permission.updated_at.toISOString()
          }
        })
      } else {
        // No permission set, return undefined
        return res.status(200).json({
          status: 'success',
          description:
            sender != null
              ? `No permission setting found for sender ${sender} to ${normalizedMessageBox}.`
              : `No box-wide permission setting found for ${normalizedMessageBox}.`,
          permission: null
        })
      }
    } catch (error) {
      Logger.error('[ERROR] Internal Server Error in get permission:', error)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}
