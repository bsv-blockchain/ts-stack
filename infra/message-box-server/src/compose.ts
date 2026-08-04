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
import { rateLimit, type Options as RateLimitOptions } from 'express-rate-limit'
import { AuthSocketServer, type AuthSocket } from '@bsv/authsocket'
import { preAuth, postAuth } from './routes/index.js'
import sendMessageRoute from './routes/sendMessage.js'
import { Logger } from './utils/logger.js'
import { bindMessageBoxRuntime } from './runtimeDeps.js'
import type { MessageBoxContext } from './context.js'
import { authenticatedIdentityKey, rateLimitOptions } from './security/rateLimitPolicy.js'
import {
  readCorsOriginSetting,
  readBodyLimitBytes,
  responseSizeLimit
} from './security/edgePolicy.js'
import { readMessageBoxResourceConfig } from './config/resources.js'
import { readMessageBoxPricingConfig } from './config/pricing.js'
import {
  authenticatedWebSocketIdentity,
  isIdentityOwnedRoom,
  messageBoxFromRecipientRoom,
  recipientSocketIds,
  WebSocketPolicyError
} from './security/webSocketPolicy.js'

export { createMessageBoxContext } from './context.js'
export type { MessageBoxContext, CreateMessageBoxContextOptions } from './context.js'
export { bindMessageBoxRuntime } from './runtimeDeps.js'

type HttpMethod = 'get' | 'post' | 'put' | 'delete'

/** Express app or router — embed mounts pieces on whichever it owns. */
export type MessageBoxRouter = IRouter

interface WebSocketState {
  authenticatedSockets: Map<string, string>
  connectedSockets: Map<string, AuthSocket>
}

const webSocketState = new WeakMap<AuthSocketServer, WebSocketState>()

type ClosableAuthSocketServer = AuthSocketServer & {
  close?: () => Promise<void>
}

type DisconnectableAuthSocket = Pick<AuthSocket, 'ioSocket'>

export function disconnectAuthenticatedSockets(sockets: Iterable<DisconnectableAuthSocket>): void {
  for (const socket of sockets) {
    socket.ioSocket.disconnect(true)
  }
}

/**
 * Close authenticated WebSockets without requiring an unpublished dependency.
 *
 * New AuthSocket releases own the complete close lifecycle. The compatibility
 * path disconnects the public underlying Socket.IO sockets used by 2.1.1, then
 * lets the standalone owner drain its HTTP server. Remove that path after the
 * governed published baseline exposes AuthSocketServer.close().
 */
export async function closeMessageBoxWebSockets(io: AuthSocketServer | null): Promise<void> {
  if (io === null) return

  const state = webSocketState.get(io)
  const nativeClose = (io as ClosableAuthSocketServer).close
  if (typeof nativeClose === 'function') {
    await nativeClose.call(io)
  } else {
    disconnectAuthenticatedSockets(state?.connectedSockets.values() ?? [])
  }
  state?.authenticatedSockets.clear()
  state?.connectedSockets.clear()
  webSocketState.delete(io)
}

export function createMessageBoxApp(): Express {
  return express()
}

export function registerMessageBoxPreAuthRoutes(
  router: MessageBoxRouter,
  routingPrefix: string = ''
): void {
  preAuth.forEach(route => {
    router[route.type as HttpMethod](
      `${routingPrefix}${route.path}`,
      route.func as unknown as (req: ExpressRequest, res: Response, next: NextFunction) => void
    )
  })
}

/** Payment middleware (after auth) + postAuth route handlers. */
export function registerMessageBoxPostAuthRoutes(
  router: MessageBoxRouter,
  ctx: Pick<MessageBoxContext, 'wallet' | 'calculateRequestPrice' | 'paymentReplayStore'>,
  routingPrefix: string = '',
  authenticatedRateLimitOptions: Partial<RateLimitOptions> = {}
): void {
  const resources = readMessageBoxResourceConfig()
  router.use(responseSizeLimit('MESSAGE_BOX', resources.listMaxResponseBytes))
  router.use(
    rateLimit(
      rateLimitOptions(
        'MESSAGE_BOX_AUTHENTICATED_RATE_LIMIT',
        { windowMs: 60_000, limit: 1_000 },
        {
          keyGenerator: authenticatedIdentityKey,
          ...authenticatedRateLimitOptions
        }
      )
    )
  )

  router.use(
    createPaymentMiddleware({
      wallet: ctx.wallet,
      calculateRequestPrice: async req =>
        await Promise.resolve(ctx.calculateRequestPrice(req as unknown as ExpressRequest)),
      replayStore: ctx.paymentReplayStore
    })
  )

  postAuth.forEach(route => {
    const method = route.type as HttpMethod
    if (route.path === '/sendMessage') {
      router[method](
        `${routingPrefix}${route.path}`,
        sendMessageRoute.func as unknown as RequestHandler
      )
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
export function attachMessageBoxWebSockets(
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
    sessionManager: ctx.sessionManager,
    maxHttpBufferSize: readBodyLimitBytes('MESSAGE_BOX_WEBSOCKET', 1024 * 1024),
    cors: {
      origin: readCorsOriginSetting('MESSAGE_BOX'),
      methods: ['GET', 'POST']
    }
  })

  // Map to store authenticated identity keys
  const authenticatedSockets = new Map<string, string>()
  const connectedSockets = new Map<string, AuthSocket>()
  const resources = readMessageBoxResourceConfig()
  const pricing = readMessageBoxPricingConfig()
  webSocketState.set(io, { authenticatedSockets, connectedSockets })

  io.on('connection', socket => {
    let activeSendEvents = 0
    let sendRateWindowStartedAt = Date.now()
    let sendEventsInWindow = 0
    connectedSockets.set(socket.id, socket)
    Logger.log('[WEBSOCKET] New connection established.')

    // Handle immediate authentication if identityKey is available
    if (typeof socket.identityKey === 'string' && socket.identityKey.trim() !== '') {
      try {
        const identityKey = authenticatedWebSocketIdentity(socket.identityKey)
        Logger.log('[DEBUG] Parsed WebSocket Identity Key Successfully:', identityKey)

        authenticatedSockets.set(socket.id, identityKey)
        Logger.log('[WEBSOCKET] Identity key stored for socket ID:', socket.id)

        // Send confirmation immediately if identity key is provided on connection
        void socket.emit('authenticationSuccess', { status: 'success' })
      } catch (error) {
        Logger.error('[ERROR] Failed to parse WebSocket identity key:', error)
      }
    } else {
      // The first signed application event completes BRC-103 peer discovery.
      // The claimed key in the payload is never trusted as an identity source.
      Logger.log('[WEBSOCKET] Waiting for the first authenticated BRC-103 event...')

      let identityKeyHandled = false

      const authListener = async (data: { identityKey?: string }): Promise<void> => {
        if (identityKeyHandled) return

        try {
          const identityKey = authenticatedWebSocketIdentity(socket.identityKey, data?.identityKey)
          authenticatedSockets.set(socket.id, identityKey)
          identityKeyHandled = true

          Logger.log('[WEBSOCKET] BRC-103 peer authenticated for socket ID:', socket.id)

          // Emit authentication success message
          await socket.emit('authenticationSuccess', { status: 'success' }).catch(error => {
            Logger.error('[WEBSOCKET ERROR] Failed to send authentication success event:', error)
          })
        } catch (error) {
          Logger.warn('[WEBSOCKET] Rejected an invalid authenticated peer or identity claim.')
          await socket.emit('authenticationFailed', {
            reason:
              error instanceof WebSocketPolicyError
                ? error.reason
                : 'Invalid authenticated identity key'
          })
        }
      }

      // Ensure `authListener` is used properly
      socket.on('authenticated', authListener)
    }

    // Handle sendMessage over WebSocket
    socket.on(
      'sendMessage',
      async (data: {
        roomId: string
        message: { messageId: string; recipient: string; body: string }
      }): Promise<void> => {
        if (typeof data !== 'object' || data == null) {
          Logger.error('[WEBSOCKET ERROR] Invalid data object received.')
          await socket.emit('messageFailed', { reason: 'Invalid data object' })
          return
        }

        const { roomId, message } = data

        if (!authenticatedSockets.has(socket.id)) {
          Logger.warn('[WEBSOCKET] Unauthorized attempt to send a message.')
          await socket.emit('paymentFailed', {
            reason: 'Unauthorized: WebSocket not authenticated'
          })
          return
        }

        if (
          resources.webSocketMaxConcurrentSends !== -1 &&
          activeSendEvents >= resources.webSocketMaxConcurrentSends
        ) {
          await socket.emit('messageFailed', {
            reason: 'Too many concurrent WebSocket sends',
            code: 'ERR_WEBSOCKET_CONCURRENCY_LIMIT'
          })
          return
        }

        const now = Date.now()
        if (now - sendRateWindowStartedAt >= 60_000) {
          sendRateWindowStartedAt = now
          sendEventsInWindow = 0
        }
        if (
          resources.webSocketSendRateLimit !== -1 &&
          sendEventsInWindow >= resources.webSocketSendRateLimit
        ) {
          await socket.emit('messageFailed', {
            reason: 'WebSocket send rate limit exceeded',
            code: 'ERR_WEBSOCKET_RATE_LIMITED'
          })
          return
        }
        sendEventsInWindow += 1
        activeSendEvents += 1

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
            Logger.error('[WEBSOCKET ERROR] Invalid message body.')
            await socket.emit('messageFailed', { reason: 'Invalid message body' })
            return
          }

          try {
            PublicKey.fromString(message.recipient)
          } catch {
            await socket.emit('messageFailed', { reason: 'Invalid recipient identity key' })
            return
          }

          const messageBoxType = messageBoxFromRecipientRoom(message.recipient, roomId)
          if (messageBoxType == null) {
            await socket.emit('messageFailed', {
              reason: 'Room does not match recipient and message box'
            })
            return
          }

          Logger.log(`[WEBSOCKET] Processing sendMessage for room: ${roomId}`)

          // BRC-105 payments are authenticated HTTP exchanges. Refuse the
          // legacy write event when monetization is enabled so current clients
          // immediately exercise their existing AuthFetch fallback instead of
          // bypassing the payment middleware.
          if (pricing.enabled) {
            await socket.emit(`sendMessageAck-${roomId}`, {
              status: 'error',
              code: 'ERR_PAYMENT_REQUIRES_AUTHFETCH'
            })
            return
          }

          // Reuse the HTTP route's complete validation, recipient-permission,
          // duplicate, quota, and persistence policy. Paid deployments are
          // routed through AuthFetch above rather than this legacy event.
          let routeStatus = 200
          let routeBody: any
          const routeResponse = {
            status: (status: number) => {
              routeStatus = status
              return routeResponse
            },
            json: (body: any) => {
              routeBody = body
              return routeResponse
            }
          } as unknown as Response
          await sendMessageRoute.func(
            {
              auth: { identityKey: authenticatedSockets.get(socket.id) },
              body: {
                message: {
                  messageId: message.messageId,
                  recipient: message.recipient,
                  messageBox: messageBoxType,
                  body: message.body
                }
              }
            } as any,
            routeResponse
          )

          if (routeStatus !== 200 || routeBody?.status !== 'success') {
            await socket.emit(`sendMessageAck-${roomId}`, {
              status: 'error',
              code: routeBody?.code ?? 'ERR_MESSAGE_REJECTED'
            })
            return
          }

          await socket.emit(`sendMessageAck-${roomId}`, {
            status: 'success',
            messageId: message.messageId
          })

          const recipientSocketIdsForMessage = recipientSocketIds(
            authenticatedSockets,
            message.recipient
          )
          const boundedRecipientSocketIds =
            resources.webSocketMaxRecipientConnections === -1
              ? recipientSocketIdsForMessage
              : recipientSocketIdsForMessage.slice(0, resources.webSocketMaxRecipientConnections)
          const recipientSockets = boundedRecipientSocketIds
            .map(socketId => connectedSockets.get(socketId))
            .filter(recipientSocket => recipientSocket != null)
          await Promise.all(
            recipientSockets.map(async recipientSocket => {
              await recipientSocket.emit(`sendMessage-${roomId}`, {
                sender: authenticatedSockets.get(socket.id),
                messageId: message.messageId,
                body: message.body
              })
            })
          )
          const recipientConnections = recipientSockets.length
          Logger.log(
            `[WEBSOCKET] Delivered message notification to ${recipientConnections} authenticated recipient connection(s).`
          )
        } catch (error) {
          Logger.error('[WEBSOCKET ERROR] Unexpected failure in sendMessage handler:', error)
          await socket.emit('messageFailed', { reason: 'Unexpected error occurred' })
        } finally {
          activeSendEvents -= 1
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

      const identityKey = authenticatedSockets.get(socket.id)
      if (identityKey == null || !isIdentityOwnedRoom(identityKey, roomId)) {
        Logger.warn("[WEBSOCKET] Rejected an attempt to join another identity's room.")
        await socket.emit('joinFailed', { reason: 'Room is not owned by authenticated identity' })
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

      const identityKey = authenticatedSockets.get(socket.id)
      if (identityKey == null || !isIdentityOwnedRoom(identityKey, roomId)) {
        Logger.warn("[WEBSOCKET] Rejected an attempt to leave another identity's room.")
        await socket.emit('leaveFailed', { reason: 'Room is not owned by authenticated identity' })
        return
      }

      Logger.log(`[WEBSOCKET] User ${socket.id} left room ${roomId}`)
      await socket.emit('leftRoom', { roomId })
    })

    // Clean up on disconnect
    socket.on('disconnect', (reason: string) => {
      Logger.log(`[WEBSOCKET] Disconnected: ${reason}`)
      authenticatedSockets.delete(socket.id)
      connectedSockets.delete(socket.id)
    })
  })

  return io
}
