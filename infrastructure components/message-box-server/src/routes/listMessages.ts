/**
 * @file listMessages.ts
 * @description
 * This route allows an authenticated user to retrieve messages from a specific named messageBox.
 *
 * Messages are only returned if the authenticated identity has access to the specified messageBox.
 * If the messageBox does not exist, an empty message list is returned.
 *
 * Typical usage: Inbox or queue retrieval for real-time or deferred message delivery.
 */

import { Response } from 'express'
import knexConfig from '../../knexfile.js'
import * as knexLib from 'knex'
import { AuthRequest } from '@bsv/auth-express-middleware'

// Load the appropriate Knex configuration based on the environment
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
 * @interface ListMessagesRequest
 * @extends Request
 * @description Extends Express Request to include `auth` identity and expected `messageBox` body property.
 */
interface ListMessagesRequest extends AuthRequest {
  body: { messageBox?: string }
}

/**
 * @openapi
 * /listMessages:
 *   post:
 *     summary: Retrieve messages from a specific messageBox
 *     description: |
 *       Returns all stored messages for the specified messageBox that belong to the authenticated identity.
 *       If the box does not exist or has no messages, an empty array is returned.
 *     tags:
 *       - Message
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               messageBox:
 *                 type: string
 *                 description: The name of the messageBox to retrieve messages from
 *     responses:
 *       200:
 *         description: Successfully retrieved messages (can be empty)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 messages:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       messageId:
 *                         type: string
 *                       body:
 *                         type: string
 *                       sender:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 *       400:
 *         description: Invalid or missing messageBox name
 *       500:
 *         description: Internal server/database error
 */

/**
 * @exports
 * Route definition used by the Express router to expose the `/listMessages` POST endpoint.
 * Responsible for querying stored messages from a messageBox owned by the authenticated user.
 */
export default {
  type: 'post',
  path: '/listMessages',
  knex,
  summary: 'Use this route to list messages from your messageBox.',
  parameters: {
    messageBox: 'The name of the messageBox you would like to list messages from.'
  },
  exampleResponse: {
    status: 'success',
    messages: [
      {
        messageId: '3301',
        body: '{}',
        sender: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1'
      }
    ]
  },
  /**
 * @function func
 * @description
 * Express handler for listing stored messages in a specified messageBox.
 *
 * Input:
 * - `req.body.messageBox`: Name of the messageBox to retrieve messages from.
 * - `req.auth.identityKey`: Authenticated user’s public identity key.
 *
 * Behavior:
 * - Checks if the specified messageBox exists for the identity.
 * - If found, returns all messages in that messageBox.
 * - If not found, returns an empty array.
 * - Normalizes all message bodies to strings for consistent output.
 *
 * Output:
 * - 200 with `{ status: 'success', messages: [...] }`
 * - 400 if input is missing or malformed.
 * - 500 on internal server/database errors.
 *
 * @param {ListMessagesRequest} req - Authenticated request containing the messageBox name
 * @param {Response} res - Express response object
 * @returns {Promise<Response>} JSON response containing message records or an error
 */
  func: async (req: ListMessagesRequest, res: Response): Promise<Response> => {
    try {
      const { messageBox } = req.body

      // Validate a messageBox is provided and is a string
      if (messageBox == null || messageBox === '') {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_MESSAGEBOX_REQUIRED',
          description: 'Please provide the name of a valid MessageBox!'
        })
      }

      if (typeof messageBox !== 'string') {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_MESSAGEBOX',
          description: 'MessageBox name must be a string!'
        })
      }

      // Find the messageBox ID for this user
      const [messageBoxRecord] = await knex('messageBox')
        .where({
          identityKey: req.auth?.identityKey,
          type: messageBox
        })
        .select('messageBoxId')

      // Return empty array if no messageBox was found
      if (messageBoxRecord === undefined) {
        return res.status(200).json({
          status: 'success',
          messages: []
        })
      }

      // Retrieve all messages associated with the messageBox
      const messages = await knex('messages')
        .where({
          recipient: req.auth?.identityKey,
          messageBoxId: messageBoxRecord.messageBoxId
        })
        .select('messageId', 'body', 'sender', 'created_at', 'updated_at')

      // Normalize all message bodies to strings and convert to camelCase
      const formattedMessages = messages.map(message => ({
        messageId: message.messageId,
        body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body),
        sender: message.sender,
        createdAt: message.created_at,
        updatedAt: message.updated_at
      }))

      // Return a list of matching messages
      return res.status(200).json({
        status: 'success',
        messages: formattedMessages
      })
    } catch (e) {
      console.error(e)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL_ERROR',
        description: 'An internal error has occurred while listing messages.'
      })
    }
  }
}
