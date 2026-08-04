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
import { listQueryBatchSize, readMessageBoxResourceConfig } from '../config/resources.js'

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
    skip?: number
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
 *               limit:
 *                 type: integer
 *                 minimum: 1
 *                 default: 1000
 *               offset:
 *                 type: integer
 *                 minimum: 0
 *                 default: 0
 *               skip:
 *                 type: integer
 *                 minimum: 0
 *                 description: Compatibility alias for offset
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
 *                 limit:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 nextOffset:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
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

      const resourceConfig = readMessageBoxResourceConfig()
      const configuredDefault =
        resourceConfig.listDefaultLimit === -1
          ? Number.MAX_SAFE_INTEGER
          : resourceConfig.listDefaultLimit
      const limit = req.body.limit ?? configuredDefault
      const offset = req.body.offset ?? req.body.skip ?? 0
      if (req.body.offset != null && req.body.skip != null && req.body.offset !== req.body.skip) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_OFFSET',
          description: 'offset and skip must match when both are provided.'
        })
      }
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        (resourceConfig.listMaxLimit !== -1 && limit > resourceConfig.listMaxLimit)
      ) {
        const maximum =
          resourceConfig.listMaxLimit === -1
            ? 'the JavaScript safe-integer maximum'
            : String(resourceConfig.listMaxLimit)
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_LIMIT',
          description: `limit must be an integer between 1 and ${maximum}.`
        })
      }
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (resourceConfig.listMaxOffset !== -1 && offset > resourceConfig.listMaxOffset)
      ) {
        const maximum =
          resourceConfig.listMaxOffset === -1
            ? 'the JavaScript safe-integer maximum'
            : String(resourceConfig.listMaxOffset)
        return res.status(400).json({
          status: 'error',
          code: 'ERR_INVALID_OFFSET',
          description: `offset must be an integer between 0 and ${maximum}.`
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
          nextOffset: offset,
          hasMore: false
        })
      }

      // Retrieve bounded chunks. Deriving the chunk size from the configured
      // message and response ceilings prevents one query from materializing a
      // full item-count page of maximum-size bodies.
      const formattedMessages: Array<Record<string, unknown>> = []
      const batchSize = listQueryBatchSize(resourceConfig)
      let queryOffset = offset
      let hasMore = false
      let encodedBytes = 256

      // Read one additional row in a final bounded query so `hasMore` remains
      // correct even when the byte-derived database batch divides the page
      // limit exactly.
      while (formattedMessages.length <= limit) {
        const remaining = limit - formattedMessages.length
        const take = Math.max(1, Math.min(batchSize, remaining + 1))
        const messageRows = await runtimeDeps
          .knex('messages')
          .where({
            recipient: identityKey,
            messageBoxId: messageBoxRecord.messageBoxId
          })
          .where(function () {
            this.whereNull('expires_at').orWhere('expires_at', '>', new Date())
          })
          .select('messageId', 'body', 'sender', 'created_at', 'updated_at')
          .orderBy('created_at', 'asc')
          .orderBy('messageId', 'asc')
          .limit(take)
          .offset(queryOffset)

        if (messageRows.length === 0) break
        for (const message of messageRows) {
          if (formattedMessages.length >= limit) {
            hasMore = true
            break
          }
          const formatted = {
            messageId: message.messageId,
            body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body),
            sender: message.sender,
            createdAt: message.created_at,
            updatedAt: message.updated_at
          }
          const itemBytes = Buffer.byteLength(JSON.stringify(formatted), 'utf8') + 1
          if (
            resourceConfig.listMaxResponseBytes !== -1 &&
            encodedBytes + itemBytes > resourceConfig.listMaxResponseBytes
          ) {
            if (formattedMessages.length === 0) {
              return res.status(413).json({
                status: 'error',
                code: 'ERR_MESSAGE_RESPONSE_TOO_LARGE',
                description: 'The oldest message exceeds the configured listing response budget.'
              })
            }
            hasMore = true
            break
          }
          formattedMessages.push(formatted)
          encodedBytes += itemBytes
          queryOffset += 1
        }
        if (hasMore || messageRows.length < take) break
      }

      // Return a list of matching messages
      return res.status(200).json({
        status: 'success',
        messages: formattedMessages,
        limit,
        offset,
        nextOffset: offset + formattedMessages.length,
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
