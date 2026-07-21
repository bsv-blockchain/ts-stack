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
import type { Server as HttpServer } from 'http'
import { PublicKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { AuthSocketServer } from '@bsv/authsocket'
import { preAuth, postAuth } from './routes/index.js'
import sendMessageRoute from './routes/sendMessage.js'
import { setupSwagger } from './swagger.js'
import { Logger } from './utils/logger.js'
import { bindMessageBoxRuntime } from './runtimeDeps.js'
import {
  createMessageBoxContext,
  type MessageBoxContext,
  type CreateMessageBoxContextOptions
} from './context.js'

export { createMessageBoxContext }
export type { MessageBoxContext, CreateMessageBoxContextOptions }

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
    router[route.type as 'get' | 'post' | 'put' | 'delete'](
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
    if (route.path === '/sendMessage') {
      router[route.type as 'get' | 'post' | 'put' | 'delete'](
        route.path,
        sendMessageRoute.func as unknown as RequestHandler
      )
    } else {
      router[route.type as 'get' | 'post' | 'put' | 'delete'](
        route.path,
        route.func as RequestHandler
      )
    }
  })

  const prefix = ctx.routingPrefix ?? ''
  app.use(prefix === '' ? '/' : prefix, router)
}

/**
 * Attach authenticated WebSocket handlers (same behavior as standalone index.ts).
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

  const authenticatedSockets = new Map<string, string>()
  const knex = ctx.knex

  io.on('connection', (socket) => {
    Logger.log('[WEBSOCKET] New connection established.')

    if (typeof socket.identityKey === 'string' && socket.identityKey.trim() !== '') {
      try {
        const parsedIdentityKey = PublicKey.fromString(socket.identityKey)
        Logger.log('[DEBUG] Parsed WebSocket Identity Key Successfully:', parsedIdentityKey.toString())
        authenticatedSockets.set(socket.id, parsedIdentityKey.toString())
        Logger.log('[WEBSOCKET] Identity key stored for socket ID:', socket.id)
        void socket.join(socket.identityKey)
        Logger.log(`[WEBSOCKET] Socket joined room: ${socket.identityKey}`)
        socket.emit('authenticationSuccess', { message: 'WebSocket authentication successful' })
      } catch (error) {
        Logger.error('[ERROR] Failed to parse WebSocket identity key:', error)
        socket.emit('authenticationFailed', { message: 'Invalid identity key format' })
        socket.disconnect()
      }
    } else {
      Logger.error('[ERROR] WebSocket connection missing identityKey')
      socket.emit('authenticationFailed', { message: 'Missing identity key' })
      socket.disconnect()
    }

    socket.on(
      'joinRoom',
      (
        roomId: string,
        callback?: (response: { status: 'success' | 'error', message?: string }) => void
      ) => {
        void (async () => {
          try {
            if (typeof socket.identityKey !== 'string' || socket.identityKey.trim() === '') {
              Logger.error('[ERROR] joinRoom failed: Socket is not authenticated')
              if (typeof callback === 'function') {
                callback({ status: 'error', message: 'Unauthorized: WebSocket not authenticated' })
              }
              return
            }
            await socket.join(roomId)
            Logger.log(`[WEBSOCKET] Socket joined room: ${roomId}`)
            if (typeof callback === 'function') {
              callback({ status: 'success' })
            }
          } catch (error) {
            Logger.error('[ERROR] Failed to join room:', error)
            if (typeof callback === 'function') {
              callback({ status: 'error', message: 'Failed to join room' })
            }
          }
        })()
      }
    )

    socket.on(
      'sendMessage',
      (
        roomId: string,
        payload: any,
        callback?: (response: { status: 'success' | 'error', messageId?: string, message?: string }) => void
      ) => {
        void (async () => {
          try {
            Logger.log(`[WEBSOCKET] Processing sendMessage for room: ${roomId}`)
            if (typeof socket.identityKey !== 'string' || socket.identityKey.trim() === '') {
              Logger.error('[ERROR] sendMessage failed: Socket is not authenticated')
              if (typeof callback === 'function') {
                callback({ status: 'error', message: 'Unauthorized: WebSocket not authenticated' })
              }
              await socket.emit('paymentFailed', { reason: 'Unauthorized: WebSocket not authenticated' })
              return
            }
            if (payload == null || typeof payload !== 'object') {
              throw new Error('Invalid payload format')
            }
            if (typeof payload.messageId !== 'string' || payload.messageId.trim() === '') {
              throw new Error('Invalid or missing messageId')
            }
            if (typeof payload.recipient !== 'string' || payload.recipient.trim() === '') {
              throw new Error('Invalid or missing recipient')
            }
            if (typeof payload.body !== 'string' && typeof payload.body !== 'object') {
              throw new Error('Invalid or missing body')
            }

            const ackPayload = {
              messageId: payload.messageId,
              status: 'awaitingConfirmation',
              recipient: payload.recipient
            }
            await socket.emit(`sendMessageAck-${roomId}`, ackPayload)

            await knex('messages').insert({
              messageId: payload.messageId,
              sender: socket.identityKey,
              recipient: payload.recipient,
              body: typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body),
              created_at: new Date()
            })

            void io.emit(`sendMessage-${roomId}`, {
              messageId: payload.messageId,
              sender: socket.identityKey,
              recipient: payload.recipient,
              body: payload.body
            })

            if (typeof callback === 'function') {
              callback({ status: 'success', messageId: payload.messageId })
            }
          } catch (error) {
            Logger.error('[WEBSOCKET ERROR] Unexpected failure in sendMessage handler:', error)
            if (typeof callback === 'function') {
              callback({
                status: 'error',
                message: error instanceof Error ? error.message : 'Unexpected server error'
              })
            }
          }
        })()
      }
    )

    socket.on('disconnect', () => {
      authenticatedSockets.delete(socket.id)
      Logger.log(`[WEBSOCKET] Socket disconnected: ${socket.id}`)
    })
  })

  return io
}
