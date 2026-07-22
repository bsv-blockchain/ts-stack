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
  Router
} from 'express'
import bodyParser from 'body-parser'
import type { Server as HttpServer } from 'node:http'
import { PublicKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { AuthSocketServer } from '@bsv/authsocket'
import { preAuth, postAuth } from './routes/index.js'
import sendMessageRoute from './routes/sendMessage.js'
import { setupSwagger } from './swagger.js'
import { Logger } from './utils/logger.js'
import { bindMessageBoxRuntime } from './runtimeDeps.js'
import type { MessageBoxContext } from './context.js'

export { createMessageBoxContext } from './context.js'
export type { MessageBoxContext, CreateMessageBoxContextOptions } from './context.js'

type HttpMethod = 'get' | 'post' | 'put' | 'delete'


export function createMessageBoxApp (): Express {
  return express()
}

/**
 * Mount messagebox HTTP routes on an Express app.
 * Auth/payment middleware apply only to this router (not the parent app).
 */
export function mountMessageBoxRoutes (app: Express, ctx: MessageBoxContext): void {
  bindMessageBoxRuntime({ knex: ctx.knex, wallet: ctx.wallet })

  const router = Router()
  router.use(bodyParser.json({ limit: '1gb', type: 'application/json' }))
  router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', '*')
    res.header('Access-Control-Allow-Methods', '*')
    res.header('Access-Control-Expose-Headers', '*')
    res.header('Access-Control-Allow-Private-Network', 'true')
    if (req.method === 'OPTIONS') {
      res.sendStatus(200)
    } else {
      next()
    }
  })

  if (ctx.enableSwagger) {
    setupSwagger(app)
  }

  preAuth.forEach((route) => {
    router[route.type as HttpMethod](
      route.path,
      route.func as unknown as (req: ExpressRequest, res: Response, next: NextFunction) => void
    )
  })

  router.use(
    createAuthMiddleware({
      wallet: ctx.wallet,
      logger: ctx.logger
    })
  )

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
      router[method](route.path, sendMessageRoute.func as unknown as RequestHandler)
    } else {
      router[method](route.path, route.func as RequestHandler)
    }
  })

  const prefix = ctx.routingPrefix ?? ''
  app.use(prefix === '' ? '/' : prefix, router)
}

/**
 * Attach authenticated WebSocket handlers. Mirrors standalone index.ts behavior
 * with injected wallet/knex instead of module singletons.
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

  const knex = ctx.knex
  const authenticatedSockets = new Map<string, string>()

  io.on('connection', (socket) => {
    Logger.log('[WEBSOCKET] New connection established.')

    if (typeof socket.identityKey === 'string' && socket.identityKey.trim() !== '') {
      try {
        const parsedIdentityKey = PublicKey.fromString(socket.identityKey)
        Logger.log('[DEBUG] Parsed WebSocket Identity Key Successfully:', parsedIdentityKey.toString())
        authenticatedSockets.set(socket.id, parsedIdentityKey.toString())
        Logger.log('[WEBSOCKET] Identity key stored for socket ID:', socket.id)
        void socket.emit('authenticationSuccess', { status: 'success' })
      } catch (error) {
        Logger.error('[ERROR] Failed to parse WebSocket identity key:', error)
      }
    } else {
      Logger.warn('[WARN] WebSocket connection received without identity key. Waiting for authentication...')
      let identityKeyHandled = false
      const authListener = async (data: { identityKey?: string }): Promise<void> => {
        if (identityKeyHandled) return
        Logger.log('[WEBSOCKET] Received authentication data:', data)
        if (data?.identityKey != null && data.identityKey.trim().length > 0) {
          try {
            const parsedIdentityKey = PublicKey.fromString(data.identityKey)
            authenticatedSockets.set(socket.id, parsedIdentityKey.toString())
            identityKeyHandled = true
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
      socket.on('authenticated', authListener)
    }

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
        try {
          if (typeof roomId !== 'string' || roomId.trim() === '') {
            await socket.emit('messageFailed', { reason: 'Invalid room ID' })
            return
          }
          if (typeof message !== 'object' || message == null) {
            await socket.emit('messageFailed', { reason: 'Invalid message object' })
            return
          }
          if (typeof message.body !== 'string' || message.body.trim() === '') {
            await socket.emit('messageFailed', { reason: 'Invalid message body' })
            return
          }

          socket.emit(`sendMessageAck-${roomId}`, {
            status: 'success',
            messageId: message.messageId
          }).catch((error) => {
            Logger.error(`[WEBSOCKET ERROR] Failed to emit sendMessageAck-${roomId}:`, error)
          })

          try {
            const parts = roomId.split('-')
            const messageBoxType = parts.length > 1 ? parts[1] : 'default'

            let messageBox = await knex('messageBox')
              .where({ identityKey: message.recipient, type: messageBoxType })
              .first()

            if (messageBox == null) {
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
            const senderKey = authenticatedSockets.get(socket.id) ?? null

            await knex('messages')
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
          } catch (dbError) {
            Logger.error('[WEBSOCKET ERROR] Failed to store message in DB:', dbError)
            await socket.emit('messageFailed', { reason: 'Failed to store message' })
            return
          }

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

    socket.on('joinRoom', async (roomId: string) => {
      if (!authenticatedSockets.has(socket.id)) {
        await socket.emit('joinFailed', { reason: 'Unauthorized: WebSocket not authenticated' })
        return
      }
      if (typeof roomId !== 'string' || roomId.trim() === '') {
        await socket.emit('joinFailed', { reason: 'Invalid room ID' })
        return
      }
      Logger.log(`[WEBSOCKET] User ${socket.id} joined room ${roomId}`)
      await socket.emit('joinedRoom', { roomId })
    })

    socket.on('leaveRoom', async (roomId: string) => {
      if (!authenticatedSockets.has(socket.id)) {
        await socket.emit('leaveFailed', { reason: 'Unauthorized: WebSocket not authenticated' })
        return
      }
      if (typeof roomId !== 'string' || roomId.trim() === '') {
        await socket.emit('leaveFailed', { reason: 'Invalid room ID' })
        return
      }
      Logger.log(`[WEBSOCKET] User ${socket.id} left room ${roomId}`)
      await socket.emit('leftRoom', { roomId })
    })

    socket.on('disconnect', (reason: string) => {
      Logger.log(`[WEBSOCKET] Disconnected: ${reason}`)
      authenticatedSockets.delete(socket.id)
    })
  })

  return io
}
