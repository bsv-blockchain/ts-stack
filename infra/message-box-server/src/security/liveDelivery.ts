import type { Request as ExpressRequest, Response } from 'express'
import { Logger } from '../utils/logger.js'
import { readMessageBoxResourceConfig } from '../config/resources.js'
import { mapWithConcurrency } from '../utils/boundedConcurrency.js'
import type { WebSocketConnectionRegistry } from './webSocketConnections.js'

/**
 * Late-bound handle to the socket registry. HTTP routes are mounted before (or
 * without) `attachMessageBoxWebSockets`, so both sides share this object and
 * `connections` stays null until sockets are attached.
 */
export interface LiveDelivery {
  connections: WebSocketConnectionRegistry | null
}

export function createLiveDelivery(): LiveDelivery {
  return { connections: null }
}

export interface LiveMessage {
  sender: string | undefined
  recipient: string
  roomId: string
  messageId: string
  body: string
}

/**
 * The one place a stored message is announced to joined sockets of this
 * process. Sockets on other nodes are not reached (see sticky sessions in
 * DEPLOYING.md).
 */
export async function deliverLiveMessage(
  connections: WebSocketConnectionRegistry,
  message: LiveMessage
): Promise<void> {
  const recipientSockets = connections.recipientSockets(
    message.recipient,
    message.roomId,
    readMessageBoxResourceConfig().webSocketMaxRecipientConnections
  )
  await Promise.all(
    recipientSockets.map(async recipientSocket => {
      await recipientSocket.emit(`sendMessage-${message.roomId}`, {
        sender: message.sender,
        messageId: message.messageId,
        body: message.body
      })
    })
  )
}

/**
 * Wrap an HTTP send handler so a successful store is announced like a socket
 * send. Runs after the response is written; the status and body sent are
 * unchanged, though `res.status` and `res.json` are wrapped to observe them.
 */
export function withLiveDelivery(
  liveDelivery: LiveDelivery,
  handler: (req: ExpressRequest, res: Response) => Promise<unknown>
): (req: ExpressRequest, res: Response) => Promise<unknown> {
  return async (req, res) => {
    let status = 200
    let payload: unknown
    const originalStatus = res.status.bind(res)
    const originalJson = res.json.bind(res)
    res.status = (code: number) => {
      status = code
      return originalStatus(code)
    }
    res.json = (body: unknown) => {
      payload = body
      return originalJson(body)
    }
    const result = await handler(req, res)
    const connections = liveDelivery.connections
    if (connections != null && status === 200) {
      try {
        await announceStored(connections, req, payload)
      } catch {
        Logger.error('[WEBSOCKET ERROR] Failed to announce an HTTP-stored message.')
      }
    }
    return result
  }
}

async function announceStored(
  connections: WebSocketConnectionRegistry,
  req: ExpressRequest,
  payload: unknown
): Promise<void> {
  const body = req.body as
    { message?: { messageBox?: unknown; body?: unknown }; payment?: unknown } | undefined
  const results = (payload as { status?: unknown; results?: unknown } | undefined)?.results
  const sent = body?.message
  // A paid send stores `{ message, payment }` per recipient, but the push
  // carries only the request body. The live handler never internalizes a
  // payment, so a consumer that acknowledges on the push would delete the row
  // before the recipient's wallet saw the output. Leave paid sends to
  // `listMessages`, which does internalize.
  if (body?.payment != null) return
  if (
    (payload as { status?: unknown } | undefined)?.status !== 'success' ||
    !Array.isArray(results) ||
    typeof sent?.messageBox !== 'string' ||
    typeof sent.body !== 'string'
  ) {
    return
  }
  const sender = (req as ExpressRequest & { auth?: { identityKey?: string } }).auth?.identityKey
  // One send reaches up to MAX_RECIPIENTS recipients and each of those up to
  // WEBSOCKET_MAX_RECIPIENT_CONNECTIONS sockets, so the product is emitted off
  // one request. Bounded like the notification fan-out the send route already
  // runs over the same list.
  await mapWithConcurrency(
    results as Array<{ recipient: string; messageId: string }>,
    readMessageBoxResourceConfig().notificationRecipientConcurrency,
    async entry => {
      await deliverLiveMessage(connections, {
        sender,
        recipient: entry.recipient,
        roomId: `${entry.recipient}-${sent.messageBox as string}`,
        messageId: entry.messageId,
        body: sent.body as string
      })
    }
  )
}
