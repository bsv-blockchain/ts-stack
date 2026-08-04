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
import {
  listQueryBatchSize,
  readMessageBoxResourceConfig,
  type MessageBoxResourceConfig
} from '../config/resources.js'

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

interface RouteFailure {
  statusCode: number
  code: string
  description: string
}

interface ListPagination {
  limit: number
  offset: number
}

interface MessagePage extends ListPagination {
  messages: Array<Record<string, unknown>>
  nextOffset: number
  hasMore: boolean
}

interface PageAccumulator {
  messages: Array<Record<string, unknown>>
  encodedBytes: number
  queryOffset: number
}

function routeFailure(statusCode: number, code: string, description: string): RouteFailure {
  return { statusCode, code, description }
}

function isRouteFailure(value: unknown): value is RouteFailure {
  return typeof value === 'object' && value != null && 'statusCode' in value
}

function normalizeMessageBoxName(value: unknown): string | RouteFailure {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return routeFailure(
      400,
      'ERR_MESSAGEBOX_REQUIRED',
      'Please provide the name of a valid MessageBox!'
    )
  }
  if (typeof value !== 'string') {
    return routeFailure(400, 'ERR_INVALID_MESSAGEBOX', 'MessageBox name must be a string!')
  }
  const normalized = value.trim()
  if (Buffer.byteLength(normalized, 'utf8') > MAX_LIST_MESSAGE_BOX_BYTES) {
    return routeFailure(
      400,
      'ERR_INVALID_MESSAGEBOX',
      `MessageBox names must not exceed ${MAX_LIST_MESSAGE_BOX_BYTES} bytes.`
    )
  }
  return normalized
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && (maximum === -1 || value <= maximum)
}

function parseListPagination(
  body: ListMessagesRequest['body'],
  resources: MessageBoxResourceConfig
): ListPagination | RouteFailure {
  if (body.offset != null && body.skip != null && body.offset !== body.skip) {
    return routeFailure(
      400,
      'ERR_INVALID_OFFSET',
      'offset and skip must match when both are provided.'
    )
  }
  const configuredDefault =
    resources.listDefaultLimit === -1 ? Number.MAX_SAFE_INTEGER : resources.listDefaultLimit
  const limit = body.limit ?? configuredDefault
  const offset = body.offset ?? body.skip ?? 0
  if (!isBoundedInteger(limit, 1, resources.listMaxLimit)) {
    const maximum =
      resources.listMaxLimit === -1
        ? 'the JavaScript safe-integer maximum'
        : String(resources.listMaxLimit)
    return routeFailure(
      400,
      'ERR_INVALID_LIMIT',
      `limit must be an integer between 1 and ${maximum}.`
    )
  }
  if (!isBoundedInteger(offset, 0, resources.listMaxOffset)) {
    const maximum =
      resources.listMaxOffset === -1
        ? 'the JavaScript safe-integer maximum'
        : String(resources.listMaxOffset)
    return routeFailure(
      400,
      'ERR_INVALID_OFFSET',
      `offset must be an integer between 0 and ${maximum}.`
    )
  }
  return { limit, offset }
}

function appendMessage(
  accumulator: PageAccumulator,
  message: Record<string, unknown>,
  maxResponseBytes: number
): 'added' | 'full' | 'oversized' {
  const formatted = {
    messageId: message.messageId,
    body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body),
    sender: message.sender,
    createdAt: message.created_at,
    updatedAt: message.updated_at
  }
  const itemBytes = Buffer.byteLength(JSON.stringify(formatted), 'utf8') + 1
  if (maxResponseBytes !== -1 && accumulator.encodedBytes + itemBytes > maxResponseBytes) {
    return accumulator.messages.length === 0 ? 'oversized' : 'full'
  }
  accumulator.messages.push(formatted)
  accumulator.encodedBytes += itemBytes
  accumulator.queryOffset += 1
  return 'added'
}

async function readMessagePage(
  identityKey: string,
  messageBoxId: number,
  pagination: ListPagination,
  resources: MessageBoxResourceConfig
): Promise<MessagePage | RouteFailure> {
  const accumulator: PageAccumulator = {
    messages: [],
    encodedBytes: 256,
    queryOffset: pagination.offset
  }
  const batchSize = listQueryBatchSize(resources)
  let hasMore = false

  while (accumulator.messages.length <= pagination.limit) {
    const remaining = pagination.limit - accumulator.messages.length
    const take = Math.max(1, Math.min(batchSize, remaining + 1))
    const messageRows = await runtimeDeps
      .knex('messages')
      .where({ recipient: identityKey, messageBoxId })
      .where(function () {
        this.whereNull('expires_at').orWhere('expires_at', '>', new Date())
      })
      .select('messageId', 'body', 'sender', 'created_at', 'updated_at')
      .orderBy('created_at', 'asc')
      .orderBy('messageId', 'asc')
      .limit(take)
      .offset(accumulator.queryOffset)

    if (messageRows.length === 0) break
    for (const message of messageRows) {
      if (accumulator.messages.length >= pagination.limit) {
        hasMore = true
        break
      }
      const outcome = appendMessage(accumulator, message, resources.listMaxResponseBytes)
      if (outcome === 'oversized') {
        return routeFailure(
          413,
          'ERR_MESSAGE_RESPONSE_TOO_LARGE',
          'The oldest message exceeds the configured listing response budget.'
        )
      }
      if (outcome === 'full') {
        hasMore = true
        break
      }
    }
    if (hasMore || messageRows.length < take) break
  }

  return {
    messages: accumulator.messages,
    limit: pagination.limit,
    offset: pagination.offset,
    nextOffset: accumulator.queryOffset,
    hasMore
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
      const identityKey = req.auth?.identityKey
      if (identityKey == null || identityKey.trim() === '') {
        return res.status(401).json({
          status: 'error',
          code: 'ERR_AUTHENTICATION_REQUIRED',
          description: 'Authentication required.'
        })
      }

      const normalizedMessageBox = normalizeMessageBoxName(req.body.messageBox)
      if (isRouteFailure(normalizedMessageBox)) {
        return res.status(normalizedMessageBox.statusCode).json({
          status: 'error',
          code: normalizedMessageBox.code,
          description: normalizedMessageBox.description
        })
      }
      const resourceConfig = readMessageBoxResourceConfig()
      const pagination = parseListPagination(req.body, resourceConfig)
      if (isRouteFailure(pagination)) {
        return res.status(pagination.statusCode).json({
          status: 'error',
          code: pagination.code,
          description: pagination.description
        })
      }

      const [messageBoxRecord] = await runtimeDeps
        .knex('messageBox')
        .where({
          identityKey,
          type: normalizedMessageBox
        })
        .select('messageBoxId')

      if (messageBoxRecord === undefined) {
        return res.status(200).json({
          status: 'success',
          messages: [],
          ...pagination,
          nextOffset: pagination.offset,
          hasMore: false
        })
      }

      const page = await readMessagePage(
        identityKey,
        messageBoxRecord.messageBoxId,
        pagination,
        resourceConfig
      )
      if (isRouteFailure(page)) {
        return res.status(page.statusCode).json({
          status: 'error',
          code: page.code,
          description: page.description
        })
      }
      return res.status(200).json({ status: 'success', ...page })
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
