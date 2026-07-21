import { Response } from 'express'
import type { Knex } from 'knex'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { log } from '../utils/logger.js'
import type { MessageBoxContext } from '../context.js'

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

export interface ListMessagesRoute {
  type: string
  path: string
  knex: Knex
  summary: string
  parameters: Record<string, unknown>
  exampleResponse: Record<string, unknown>
  func: (req: ListMessagesRequest, res: Response) => Promise<Response>
}

export function createListMessagesRoute (
  ctx: Pick<MessageBoxContext, 'knex'>
): ListMessagesRoute {
  const { knex } = ctx

  return {
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
    func: async (req: ListMessagesRequest, res: Response): Promise<Response> => {
      try {
        const { messageBox } = req.body

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

        const [messageBoxRecord] = await knex('messageBox')
          .where({
            identityKey: req.auth?.identityKey,
            type: messageBox
          })
          .select('messageBoxId')

        if (messageBoxRecord === undefined) {
          return res.status(200).json({
            status: 'success',
            messages: []
          })
        }

        const messages = await knex('messages')
          .where({
            recipient: req.auth?.identityKey,
            messageBoxId: messageBoxRecord.messageBoxId
          })
          .select('messageId', 'body', 'sender', 'created_at', 'updated_at')

        const formattedMessages = messages.map(message => ({
          messageId: message.messageId,
          body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body),
          sender: message.sender,
          createdAt: message.created_at,
          updatedAt: message.updated_at
        }))

        return res.status(200).json({
          status: 'success',
          messages: formattedMessages
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
}
