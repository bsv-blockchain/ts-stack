import type { Request as ExpressRequest, Response } from 'express'
import { Logger } from '../utils/logger.js'
import { readMessageBoxResourceConfig } from '../config/resources.js'
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

/** The one place a stored message is announced to the recipient's joined sockets. */
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
 * send. Runs after the response is written and never alters it.
 */
export function withLiveDelivery(
  liveDelivery: LiveDelivery | undefined,
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
    const connections = liveDelivery?.connections
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
  const results = (payload as { status?: unknown; results?: unknown } | undefined)?.results
  const sent = (req.body as { message?: { messageBox?: unknown; body?: unknown } } | undefined)
    ?.message
  if (
    (payload as { status?: unknown } | undefined)?.status !== 'success' ||
    !Array.isArray(results) ||
    typeof sent?.messageBox !== 'string' ||
    typeof sent.body !== 'string'
  ) {
    return
  }
  const sender = (req as ExpressRequest & { auth?: { identityKey?: string } }).auth?.identityKey
  await Promise.all(
    results.map(async (entry: { recipient: string; messageId: string }) => {
      await deliverLiveMessage(connections, {
        sender,
        recipient: entry.recipient,
        roomId: `${entry.recipient}-${sent.messageBox as string}`,
        messageId: entry.messageId,
        body: sent.body as string
      })
    })
  )
}
