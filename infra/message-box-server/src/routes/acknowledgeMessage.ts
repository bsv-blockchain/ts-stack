/**
 * @file acknowledgeMessage.ts
 * @description
 * Express route to allow a client to acknowledge receipt of one or more messages.
 * Acknowledged messages are permanently removed from the database for the
 * authenticated identity key (recipient).
 *
 * This is used in the MessageBox system to clear delivered messages once received
 * and handled on the client side (e.g., after syncing or displaying them).
 */

import { Request, Response } from 'express'
import knexConfig from '../../knexfile.js'
import * as knexLib from 'knex'
import { Logger } from '../utils/logger.js'

// Determine environment and initialize Knex connection
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
 * @interface AcknowledgeRequest
 * @extends Request
 * @description Represents an authenticated request body for acknowledging messages.
 */
export interface AcknowledgeRequest extends Request {
  auth: { identityKey: string }
  body: { messageIds?: string[] }
}

/**
 * @openapi
 * /acknowledgeMessage:
 *   post:
 *     summary: Acknowledge receipt of one or more messages
 *     description: |
 *       Removes acknowledged messages from the database for the authenticated identity key.
 *       This is used after a client has received and handled messages.
 *     tags:
 *       - Message
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               messageIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of message IDs to acknowledge
 *     responses:
 *       200:
 *         description: Successfully acknowledged messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *       400:
 *         description: Invalid input or message not found
 *       500:
 *         description: Internal server error
 */

/**
 * @exports
 * Route definition for acknowledging MessageBox messages.
 * This object is consumed by the Express route loader to register the endpoint.
 */
export default {
  type: 'post',
  path: '/acknowledgeMessage',
  knex,
  summary: 'Use this route to acknowledge a message has been received',
  parameters: {
    messageIds: ['3301']
  },
  exampleResponse: {
    status: 'success'
  },
  errors: [],

  /**
   * @function func
   * @description
   * Express route handler that processes a POST request to acknowledge messages.
   * Deletes messages from the database where:
   *   - recipient matches the authenticated identity key
   *   - messageId matches one or more of the provided IDs
   *
   * Returns:
   *   - 200 success if deletion occurs
   *   - 400 if no messages were found or input is invalid
   *   - 500 on internal error
   *
   * @param {AcknowledgeRequest} req - Express request object containing auth and message IDs
   * @param {Response} res - Express response object
   * @returns {Promise<Response>} JSON response with status and optional error codes
   */
  func: async (req: AcknowledgeRequest, res: Response): Promise<Response> => {
    try {
      const { messageIds } = req.body

      Logger.log('[SERVER] acknowledgeMessage called for messageIds:', messageIds, 'by', req.auth.identityKey)

      // Validate request: must be a non-empty array of strings
      if ((messageIds == null) || (Array.isArray(messageIds) && messageIds.length === 0)) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_MESSAGE_ID_REQUIRED',
          description: 'Please provide the ID of the message(s) to acknowledge!'
        })
      }

      if (!Array.isArray(messageIds) || messageIds.some(id => typeof id !== 'string')) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_MESSAGE_ID',
          description: 'Message IDs must be formatted as an array of strings!'
        })
      }

      // Delete acknowledged messages for this recipient from the database
      const deleted = await knex('messages')
        .where({ recipient: req.auth.identityKey })
        .whereIn('messageId', Array.isArray(messageIds) ? messageIds : [messageIds])
        .del()

      // No matching messages found
      if (deleted === 0) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_ACKNOWLEDGMENT',
          description: 'Message not found!'
        })
      }

      // Deletion failed unexpectedly
      if (deleted < 0) {
        throw new Error('Deletion failed')
      }

      return res.status(200).json({ status: 'success' })
    } catch (e) {
      Logger.error(e)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL_ERROR',
        description: 'An internal error has occurred while acknowledging the message'
      })
    }
  }
}
