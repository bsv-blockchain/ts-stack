import { Request, Response } from 'express'
import type { Knex } from 'knex'
import { Logger } from '../utils/logger.js'
import type { MessageBoxContext } from '../context.js'

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

export interface AcknowledgeMessageRoute {
  type: string
  path: string
  knex: Knex
  summary: string
  parameters: Record<string, unknown>
  exampleResponse: Record<string, unknown>
  errors: unknown[]
  func: (req: AcknowledgeRequest, res: Response) => Promise<Response>
}

export function createAcknowledgeMessageRoute (
  ctx: Pick<MessageBoxContext, 'knex'>
): AcknowledgeMessageRoute {
  const { knex } = ctx

  return {
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

    func: async (req: AcknowledgeRequest, res: Response): Promise<Response> => {
      try {
        const { messageIds } = req.body

        Logger.log('[SERVER] acknowledgeMessage called for messageIds:', messageIds, 'by', req.auth.identityKey)

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

        const deleted = await knex('messages')
          .where({ recipient: req.auth.identityKey })
          .whereIn('messageId', Array.isArray(messageIds) ? messageIds : [messageIds])
          .del()

        if (deleted === 0) {
          return res.status(400).json({
            status: 'error',
            code: 'ERR_INVALID_ACKNOWLEDGMENT',
            description: 'Message not found!'
          })
        }

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
}
