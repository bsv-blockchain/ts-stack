/**
 * Composable entrypoints for embedding messagebox in a parent app.
 * Standalone binary continues to use index.ts → app.ts as before.
 */
import express, {
  type Express,
  type Request as ExpressRequest,
  type Response,
  type NextFunction,
  type RequestHandler,
  type IRouter
} from 'express'
import type { Server as HttpServer } from 'node:http'
import { PublicKey } from '@bsv/sdk'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { AuthSocketServer } from '@bsv/authsocket'
import { preAuth, postAuth } from './routes/index.js'
import sendMessageRoute from './routes/sendMessage.js'
import { Logger } from './utils/logger.js'
import { bindMessageBoxRuntime } from './runtimeDeps.js'
import type { MessageBoxContext } from './context.js'

export { createMessageBoxContext } from './context.js'
export type { MessageBoxContext, CreateMessageBoxContextOptions } from './context.js'
export { bindMessageBoxRuntime } from './runtimeDeps.js'

type HttpMethod = 'get' | 'post' | 'put' | 'delete'

/** Express app or router — embed mounts pieces on whichever it owns. */
export type MessageBoxRouter = IRouter

export function createMessageBoxApp (): Express {
  return express()
}

export function registerMessageBoxPreAuthRoutes (
  router: MessageBoxRouter,
  routingPrefix: string = ''
): void {
  preAuth.forEach((route) => {
    router[route.type as HttpMethod](
      `${routingPrefix}${route.path}`,
      route.func as unknown as (req: ExpressRequest, res: Response, next: NextFunction) => void
    )
  })
}

/** Payment middleware (after auth) + postAuth route handlers. */
export function registerMessageBoxPostAuthRoutes (
  router: MessageBoxRouter,
  ctx: Pick<MessageBoxContext, 'wallet' | 'calculateRequestPrice'>,
  routingPrefix: string = ''
): void {
  router.use(
    createPaymentMiddleware({
      wallet: ctx.wallet,
      calculateRequestPrice: async (req) =>
        await Promise.resolve(ctx.calculateRequestPrice(req as unknown as ExpressRequest))
    })
  )

  postAuth.forEach((route) => {
    const method = route.type as HttpMethod
    if (route.path === '/sendMessage') {
      router[method](`${routingPrefix}${route.path}`, sendMessageRoute.func as unknown as RequestHandler)
    } else {
      router[method](`${routingPrefix}${route.path}`, route.func as RequestHandler)
    }
  })
}

/**
 * Attach authenticated WebSocket handlers.
 * Same logic as standalone index.ts start(), with ctx.knex/ctx.wallet
 * instead of module singletons.
 */
export function attachMessageBoxWebSockets (
  httpServer: HttpServer,
  ctx: MessageBoxContext
): AuthSocketServer | null {
  if (!ctx.enableWebSockets) {
    return null
  }

  bindMessageBoxRuntime({ knex: ctx.knex, wallet: ctx.wallet })

  Logger.log('[WEBSOCKET] Initializing WebSocket support...')

  const io = new AuthSocketServer(httpServer, {
    wallet: ctx.wallet,
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  })

  // Map to store authenticated identity keys
  const authenticatedSockets = new Map<string, string>()
  const knex = ctx.knex

  io.on('connection', (socket) => {
    Logger.log('[WEBSOCKET] New connection established.')

    // Handle immediate authentication if identityKey is available
    if (typeof socket.identityKey === 'string' && socket.identityKey.trim() !== '') {
      try {
        const parsedIdentityKey = PublicKey.fromString(socket.identityKey)
        Logger.log('[DEBUG] Parsed WebSocket Identity Key Successfully:', parsedIdentityKey.toString())

        authenticatedSockets.set(socket.id, parsedIdentityKey.toString())
        Logger.log('[WEBSOCKET] Identity key stored for socket ID:', socket.id)

        // Send confirmation immediately if identity key is provided on connection
        void socket.emit('authenticationSuccess', { status: 'success' })
      } catch (error) {
        Logger.error('[ERROR] Failed to parse WebSocket identity key:', error)
      }
    } else {
      // Wait for 'authenticated' event if identityKey was not in handshake
      Logger.warn('[WARN] WebSocket connection received without identity key. Waiting for authentication...')

      let identityKeyHandled = false

      const authListener = async (data: { identityKey?: string }): Promise<void> => {
        if (identityKeyHandled) return

        Logger.log('[WEBSOCKET] Received authentication data:', data)

        if (data !== null && data !== undefined && typeof data.identityKey === 'string' && data.identityKey.trim().length > 0) {
          try {
            const parsedIdentityKey = PublicKey.fromString(data.identityKey)
            Logger.log('[DEBUG] Retrieved and parsed Identity Key after connection:', parsedIdentityKey.toString())

            authenticatedSockets.set(socket.id, parsedIdentityKey.toString())
            Logger.log('[WEBSOCKET] Stored authenticated Identity Key for socket ID:', socket.id)

            identityKeyHandled = true

            Logger.log(`New authenticated WebSocket connection from: ${authenticatedSockets.get(socket.id) ?? 'unknown'}`)

            // Emit authentication success message
            await socket.emit('authenticationSuccess', { status: 'success' }).catch(error => {
              Logger.error('[WEBSOCKET ERROR] Failed to send authentication success event:', error)
            })
          } catch (error) {
            Logger.error('[ERROR] Failed to parse Identity Key from authenticated event:', error)
            await socket.emit('authenticationFailed', { reason: 'Invalid identity key format' })
          }
        } else {
          Logger.warn('[WARN] Invalid or missing identity key in authentication event.')
          await socket.emit('authenticationFailed', { reason: 'Missing identity key' })
        }
      }

      // Ensure `authListener` is used properly
      socket.on('authenticated', authListener)
    }

    // Handle sendMessage over WebSocket
    socket.on(
      'sendMessage',
      async (data: { roomId: string, message: { messageId: string, recipient: string, body: string } }): Promise<void> => {
        if (typeof data !== 'object' || data == null) {
          Logger.error('[WEBSOCKET ERROR] Invalid data object received.')
          await socket.emit('messageFailed', { reason: 'Invalid data object' })
          return
        }

        const { roomId, message } = data

        if (!authenticatedSockets.has(socket.id)) {
          Logger.warn('[WEBSOCKET] Unauthorized attempt to send a message.')
          await socket.emit('paymentFailed', { reason: 'Unauthorized: WebSocket not authenticated' })
          return
        }

        Logger.log(`[WEBSOCKET] Processing sendMessage for room: ${roomId}`)

        try {
          if (typeof roomId !== 'string' || roomId.trim() === '') {
            Logger.error('[WEBSOCKET ERROR] Invalid roomId:', roomId)
            await socket.emit('messageFailed', { reason: 'Invalid room ID' })
            return
          }

          if (typeof message !== 'object' || message == null) {
            Logger.error('[WEBSOCKET ERROR] Invalid message object:', message)
            await socket.emit('messageFailed', { reason: 'Invalid message object' })
            return
          }

          if (typeof message.body !== 'string' || message.body.trim() === '') {
            Logger.error('[WEBSOCKET ERROR] Invalid message body:', message.body)
            await socket.emit('messageFailed', { reason: 'Invalid message body' })
            return
          }

          Logger.log(`[WEBSOCKET] Acknowledging message ${message.messageId} to sender.`)

          const ackPayload = {
            status: 'success',
            messageId: message.messageId
          }

          Logger.log(`[WEBSOCKET] Emitting ack event: sendMessageAck-${roomId}`)

          socket.emit(`sendMessageAck-${roomId}`, ackPayload).catch((error) => {
            Logger.error(`[WEBSOCKET ERROR] Failed to emit sendMessageAck-${roomId}:`, error)
          })

          // Store message in the database just like HTTP sendMessage route
          try {
            const parts = roomId.split('-')
            const messageBoxType = parts.length > 1 ? parts[1] : 'default'

            Logger.log(`[WEBSOCKET] Parsed messageBoxType: ${messageBoxType}`)
            Logger.log(`[WEBSOCKET] Attempting to store message for recipient: ${message.recipient}, box type: ${messageBoxType}`)

            let messageBox = await knex('messageBox')
              .where({ identityKey: message.recipient, type: messageBoxType })
              .first()

            if (messageBox === null || messageBox === undefined) {
              Logger.log('[WEBSOCKET] messageBox not found. Creating new messageBox.')
              await knex('messageBox').insert({
                identityKey: message.recipient,
                type: messageBoxType,
                created_at: new Date(),
                updated_at: new Date()
              })
            }

            messageBox = await knex('messageBox')
              .where({ identityKey: message.recipient, type: messageBoxType })
              .select('messageBoxId')
              .first()

            const messageBoxId = messageBox?.messageBoxId ?? null

            if (messageBoxId === null || messageBoxId === undefined) {
              Logger.warn('[WEBSOCKET WARNING] messageBoxId is null — message may not be stored correctly!')
            } else {
              Logger.log(`[WEBSOCKET] Resolved messageBoxId: ${String(messageBoxId)}`)
            }

            const senderKey = authenticatedSockets.get(socket.id) ?? null

            const insertResult = await knex('messages')
              .insert({
                messageId: message.messageId,
                messageBoxId,
                sender: senderKey,
                recipient: message.recipient,
                body: message.body,
                created_at: new Date(),
                updated_at: new Date()
              })
              .onConflict('messageId')
              .ignore()

            if (insertResult.length === 0) {
              Logger.warn('[WEBSOCKET WARNING] Message insert was ignored due to conflict (duplicate messageId?)')
            } else {
              Logger.log('[WEBSOCKET] Message successfully stored in DB.')
            }
          } catch (dbError) {
            Logger.error('[WEBSOCKET ERROR] Failed to store message in DB:', dbError)
            await socket.emit('messageFailed', { reason: 'Failed to store message' })
            return
          }

          Logger.log(`[WEBSOCKET] Emitting message to room ${roomId}`)
          io.emit(`sendMessage-${roomId}`, {
            sender: authenticatedSockets.get(socket.id),
            messageId: message.messageId,
            body: message.body
          })
        } catch (error) {
          Logger.error('[WEBSOCKET ERROR] Unexpected failure in sendMessage handler:', error)
          await socket.emit('messageFailed', { reason: 'Unexpected error occurred' })
        }
      }
    )

    // Handle joining/leaving rooms
    socket.on('joinRoom', async (roomId: string) => {
      if (!authenticatedSockets.has(socket.id)) {
        Logger.warn('[WEBSOCKET] Unauthorized attempt to join a room.')
        await socket.emit('joinFailed', { reason: 'Unauthorized: WebSocket not authenticated' })
        return
      }

      if (roomId == null || typeof roomId !== 'string' || roomId.trim() === '') {
        Logger.error('[WEBSOCKET ERROR] Invalid roomId:', roomId)
        await socket.emit('joinFailed', { reason: 'Invalid room ID' })
        return
      }

      Logger.log(`[WEBSOCKET] User ${socket.id} joined room ${roomId}`)
      await socket.emit('joinedRoom', { roomId })
    })

    socket.on('leaveRoom', async (roomId: string) => {
      if (!authenticatedSockets.has(socket.id)) {
        Logger.warn('[WEBSOCKET] Unauthorized attempt to leave a room.')
        await socket.emit('leaveFailed', { reason: 'Unauthorized: WebSocket not authenticated' })
        return
      }

      if (roomId == null || roomId === '' || typeof roomId !== 'string' || roomId.trim() === '') {
        Logger.error('[WEBSOCKET ERROR] Invalid roomId:', roomId)
        await socket.emit('leaveFailed', { reason: 'Invalid room ID' })
        return
      }

      Logger.log(`[WEBSOCKET] User ${socket.id} left room ${roomId}`)
      await socket.emit('leftRoom', { roomId })
    })

    // Clean up on disconnect
    socket.on('disconnect', (reason: string) => {
      Logger.log(`[WEBSOCKET] Disconnected: ${reason}`)
      authenticatedSockets.delete(socket.id)
    })
  })

  return io
}
