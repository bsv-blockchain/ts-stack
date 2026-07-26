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
import { AuthRequest } from '@bsv/auth-express-middleware'
import { log } from '../utils/logger.js'
import { runtimeDeps } from '../runtimeDeps.js'

export const MAX_LIST_MESSAGE_BOX_BYTES = 128
export const MAX_LIST_MESSAGES_PAGE_SIZE = 1_000
export const MAX_LIST_MESSAGES_OFFSET = 100_000

/**
 * @interface ListMessagesRequest
 * @extends Request
 * @description Extends Express Request to include `auth` identity and expected `messageBox` body property.
 */
interface ListMessagesRequest extends AuthRequest {
  body: {
    messageBox?: string
    limit?: number
    offset?: number
  }
}

/**
 * @openapi
 * /listMessages:
 *   post:
 *     summary: Retrieve messages from a specific messageBox
 *     description: |
 *       Returns one deterministic, bounded page of stored messages for the specified messageBox
 *       that belong to the authenticated identity.
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
  get knex() {
    return runtimeDeps.knex
  },
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
   * - If found, returns one deterministic page from that messageBox.
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
      const identityKey = req.auth?.identityKey

      if (identityKey == null || identityKey.trim() === '') {
        return res.status(401).json({
          status: 'error',
          code: 'ERR_AUTHENTICATION_REQUIRED',
          description: 'Authentication required.'
        })
      }

      // Validate a messageBox is provided and is a string
      if (messageBox == null || (typeof messageBox === 'string' && messageBox.trim() === '')) {
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

      const normalizedMessageBox = messageBox.trim()
      if (Buffer.byteLength(normalizedMessageBox, 'utf8') > MAX_LIST_MESSAGE_BOX_BYTES) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_MESSAGEBOX',
          description: `MessageBox names must not exceed ${MAX_LIST_MESSAGE_BOX_BYTES} bytes.`
        })
      }

      const limit = req.body.limit ?? MAX_LIST_MESSAGES_PAGE_SIZE
      const offset = req.body.offset ?? 0
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_MESSAGES_PAGE_SIZE) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_LIMIT',
          description: `limit must be an integer between 1 and ${MAX_LIST_MESSAGES_PAGE_SIZE}.`
        })
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_LIST_MESSAGES_OFFSET) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_OFFSET',
          description: `offset must be an integer between 0 and ${MAX_LIST_MESSAGES_OFFSET}.`
        })
      }

      // Find the messageBox ID for this user
      const [messageBoxRecord] = await runtimeDeps
        .knex('messageBox')
        .where({
          identityKey,
          type: normalizedMessageBox
        })
        .select('messageBoxId')

      // Return empty array if no messageBox was found
      if (messageBoxRecord === undefined) {
        return res.status(200).json({
          status: 'success',
          messages: [],
          limit,
          offset,
          hasMore: false
        })
      }

      // Retrieve one bounded, deterministic page.
      const messageRows = await runtimeDeps
        .knex('messages')
        .where({
          recipient: identityKey,
          messageBoxId: messageBoxRecord.messageBoxId
        })
        .select('messageId', 'body', 'sender', 'created_at', 'updated_at')
        .orderBy('created_at', 'asc')
        .orderBy('messageId', 'asc')
        .limit(limit + 1)
        .offset(offset)

      const hasMore = messageRows.length > limit
      const messages = messageRows.slice(0, limit)

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
        messages: formattedMessages,
        limit,
        offset,
        hasMore
      })
    } catch (e) {
      log.error({ operation: 'messages.list', outcome: 'error', err: e }, 'Failed to list messages')
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL_ERROR',
        description: 'An internal error has occurred while listing messages.'
      })
    }
  }
}
