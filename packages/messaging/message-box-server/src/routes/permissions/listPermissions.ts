import { Response } from 'express'
import { AuthRequest } from '@bsv/auth-express-middleware'
import knexConfig from '../../../knexfile.js'
import * as knexLib from 'knex'
import { Logger } from '../../utils/logger.js'

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

export interface ListPermissionsRequest extends AuthRequest {
  query: {
    messageBox?: string // Optional messageBox filter
    limit?: string // Optional pagination limit
    offset?: string // Optional pagination offset
    createdAtOrder?: string // Optional sort order for created_at ('asc' | 'desc')
  }
}

/**
 * @swagger
 * /permissions/list:
 *   get:
 *     summary: List message permissions for the authenticated user
 *     description: Retrieve all permissions set by the authenticated user with optional filtering and pagination
 *     tags:
 *       - Permissions
 *     parameters:
 *       - in: query
 *         name: messageBox
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional messageBox type filter (e.g., 'notifications', 'inbox')
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 100
 *         description: Maximum number of permissions to return
 *       - in: query
 *         name: offset
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Number of permissions to skip for pagination
 *       - in: query
 *         name: createdAtOrder
 *         required: false
 *         schema:
 *           type: string
 *           enum: ['asc', 'desc']
 *           default: 'desc'
 *         description: Sort order for created_at date (asc=oldest first, desc=newest first)
 *     responses:
 *       200:
 *         description: Permissions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: 'success'
 *                 permissions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sender:
 *                         type: string
 *                         nullable: true
 *                         description: Sender identity key (null for box-wide defaults)
 *                       messageBox:
 *                         type: string
 *                         description: MessageBox type
 *                       recipientFee:
 *                         type: integer
 *                         description: Fee setting (-1=block all, 0=always allow, >0=satoshi amount)
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                       updated_at:
 *                         type: string
 *                         format: date-time
 *                 total_count:
 *                   type: integer
 *                   description: Total number of permissions (useful for pagination)
 *       400:
 *         description: Invalid query parameters
 *       401:
 *         description: Unauthorized - authentication required
 *       500:
 *         description: Internal server error
 */
export default {
  type: 'get',
  path: '/permissions/list',
  /**
   * List message permissions for the authenticated user
   *
   * @param {ListPermissionsRequest} req - Authenticated request with query parameters
   * @param {Response} res - Express response object
   * @returns {Promise<Response>} JSON response with permissions list
   */
  func: async (req: ListPermissionsRequest, res: Response): Promise<Response> => {
    Logger.log('[DEBUG] Processing /permissions/list request...')

    try {
      // Validate authentication
      if (req.auth?.identityKey == null) {
        return res.status(401).json({
          status: 'error',
          code: 'ERR_UNAUTHORIZED',
          description: 'Authentication required'
        })
      }

      // Parse and validate query parameters
      const { messageBox, limit: limitStr, offset: offsetStr, createdAtOrder } = req.query

      const limit = limitStr != null ? parseInt(limitStr, 10) : 100
      const offset = offsetStr != null ? parseInt(offsetStr, 10) : 0
      const sortOrder = createdAtOrder === 'asc' ? 'asc' : 'desc' // Default to 'desc'

      // Validate pagination parameters
      if (isNaN(limit) || limit < 1 || limit > 1000) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_LIMIT',
          description: 'Limit must be a number between 1 and 1000'
        })
      }

      if (isNaN(offset) || offset < 0) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_OFFSET',
          description: 'Offset must be a non-negative number'
        })
      }

      // Validate identity key format
      const recipientKey = req.auth.identityKey

      Logger.log(`[DEBUG] Listing permissions for recipient: ${recipientKey}, messageBox: ${messageBox ?? 'all'}, limit: ${limit}, offset: ${offset}, createdAtOrder: ${sortOrder}`)

      // Build base query
      let query = knex('message_permissions')
        .select([
          'sender',
          'message_box',
          'recipient_fee',
          'created_at',
          'updated_at'
        ])
        .where('recipient', recipientKey)
        .orderBy([
          { column: 'message_box', order: 'asc' },
          { column: 'sender', order: 'asc', nulls: 'first' }, // Box-wide (null) first
          { column: 'created_at', order: sortOrder }
        ])

      // Apply messageBox filter if provided
      if (messageBox != null) {
        query = query.where('message_box', messageBox)
      }

      // Get total count for pagination info (before applying limit/offset)
      const countQuery = query.clone().clearSelect().clearOrder().count('* as count')
      const [{ count: totalCount }] = await countQuery
      const total = parseInt(String(totalCount), 10)

      // Apply pagination
      const permissions = await query
        .limit(limit)
        .offset(offset)

      Logger.log(`[DEBUG] Found ${permissions.length} permissions (${total} total)`)

      return res.status(200).json({
        status: 'success',
        permissions: permissions.map(p => ({
          sender: p.sender, // null for box-wide defaults
          messageBox: p.message_box,
          recipientFee: p.recipient_fee,
          createdAt: p.created_at,
          updatedAt: p.updated_at
        })),
        totalCount: total
      })
    } catch (error) {
      Logger.error('[ERROR] Error listing permissions:', error)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_LIST_PERMISSIONS_FAILED',
        description: 'Failed to list permissions'
      })
    }
  }
}
