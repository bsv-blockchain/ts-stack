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
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { rateLimit, type Options as RateLimitOptions } from 'express-rate-limit'
import { AuthSocketServer, type AuthSocket } from '@bsv/authsocket'
import { preAuth, postAuth } from './routes/index.js'
import sendMessageRoute from './routes/sendMessage.js'
import { Logger } from './utils/logger.js'
import {
  runWithMessageBoxRuntime,
  snapshotBoundMessageBoxRuntime,
  type MessageBoxRuntimeDeps
} from './runtimeDeps.js'
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
  WebSocketPolicyError
} from './security/webSocketPolicy.js'
import {
  WebSocketConnectionRegistry,
  WebSocketMinuteRateLimiter
} from './security/webSocketConnections.js'
import { canonicalIdentityKey, isCanonicalMessageId } from './security/messageFields.js'
import { deliverLiveMessage, withLiveDelivery, type LiveDelivery } from './security/liveDelivery.js'

export { createMessageBoxContext } from './context.js'
export type { MessageBoxContext, CreateMessageBoxContextOptions } from './context.js'
export type { TransactionalPaymentReplayStore } from './security/TransactionalPaymentReplayStore.js'
export { bindMessageBoxRuntime } from './runtimeDeps.js'
export { createLiveDelivery } from './security/liveDelivery.js'
export type { LiveDelivery } from './security/liveDelivery.js'

type HttpMethod = 'get' | 'post' | 'put' | 'delete'

/** Express app or router — embed mounts pieces on whichever it owns. */
export type MessageBoxRouter = IRouter

interface WebSocketState {
  connections: WebSocketConnectionRegistry
  liveDelivery: LiveDelivery
}

const webSocketState = new WeakMap<AuthSocketServer, WebSocketState>()

type ClosableAuthSocketServer = AuthSocketServer & {
  close?: () => Promise<void>
}

type DisconnectableAuthSocket = Pick<AuthSocket, 'ioSocket'>

function ownStringField(value: object, field: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  return descriptor != null && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined
}

export function canonicalizeAuthenticatedIdentity(
  req: ExpressRequest,
  res: Response,
  next: NextFunction
): void {
  const auth = (req as ExpressRequest & { auth?: { identityKey?: unknown } }).auth
  if (auth == null) {
    next()
    return
  }
  const identityKey = canonicalIdentityKey(auth.identityKey)
  if (identityKey == null) {
    res.status(401).json({
      status: 'error',
      code: 'ERR_INVALID_AUTHENTICATED_IDENTITY',
      description: 'The authenticated identity key is invalid.'
    })
    return
  }
  auth.identityKey = identityKey
  next()
}

export function validateWebSocketMessage(
  roomId: unknown,
  message: unknown,
  maxBodyBytes: number
): { reason: string } | null {
  if (typeof roomId !== 'string' || roomId.trim() === '') {
    return { reason: 'Invalid room ID' }
  }
  if (
    typeof message !== 'object' ||
    message == null ||
    Array.isArray(message) ||
    (Object.getPrototypeOf(message) !== Object.prototype && Object.getPrototypeOf(message) !== null)
  ) {
    return { reason: 'Invalid message object' }
  }
  const body = ownStringField(message, 'body')
  if (
    body == null ||
    body.trim() === '' ||
    (maxBodyBytes !== -1 && Buffer.byteLength(body, 'utf8') > maxBodyBytes)
  ) {
    return { reason: 'Invalid message body' }
  }
  const recipient = ownStringField(message, 'recipient')
  if (recipient == null) {
    return { reason: 'Invalid recipient identity key' }
  }
  const canonicalRecipient = canonicalIdentityKey(recipient)
  if (canonicalRecipient == null) {
    return { reason: 'Invalid recipient identity key' }
  }
  if (canonicalRecipient !== recipient) {
    return { reason: 'Recipient identity key must use canonical encoding' }
  }
  const messageId = ownStringField(message, 'messageId')
  if (!isCanonicalMessageId(messageId)) {
    return { reason: 'Invalid message ID' }
  }
  if (messageBoxFromRecipientRoom(recipient, roomId) == null) {
    return { reason: 'Room does not match canonical recipient and message box' }
  }
  return null
}

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
    disconnectAuthenticatedSockets(state?.connections.sockets() ?? [])
  }
  state?.connections.clear()
  if (state != null && state.liveDelivery.connections === state.connections) {
    state.liveDelivery.connections = null
  }
  webSocketState.delete(io)
}

export function createMessageBoxApp(): Express {
  return express()
}

/**
 * Build the authenticated WebSocket boundary without sharing HTTP sessions.
 *
 * AuthSocket creates one Peer per Socket.IO connection. Each Peer must retain
 * the session negotiated by that exact connection: a shared identity-keyed
 * session manager can otherwise select a different tab's nonce when several
 * sockets authenticate as the same wallet.
 */
export function createMessageBoxWebSocketOptions(
  ctx: MessageBoxContext
): ConstructorParameters<typeof AuthSocketServer>[1] {
  return {
    wallet: ctx.wallet,
    maxHttpBufferSize: readBodyLimitBytes('MESSAGE_BOX_WEBSOCKET', 1024 * 1024),
    cors: {
      origin: readCorsOriginSetting('MESSAGE_BOX'),
      methods: ['GET', 'POST']
    }
  }
}

export function registerMessageBoxPreAuthRoutes(
  router: MessageBoxRouter,
  routingPrefix: string = '',
  runtime?: MessageBoxRuntimeDeps
): void {
  const isolatedRuntime = runtime ?? snapshotBoundMessageBoxRuntime()
  router.use((_req, _res, next) => runWithMessageBoxRuntime(isolatedRuntime, next))
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
  ctx: Pick<
    MessageBoxContext,
    | 'knex'
    | 'wallet'
    | 'calculateRequestPrice'
    | 'paymentReplayStore'
    | 'paymentTransactionVerifier'
    | 'liveDelivery'
  >,
  routingPrefix: string = '',
  authenticatedRateLimitOptions: Partial<RateLimitOptions> = {}
): void {
  if (ctx.liveDelivery == null) {
    throw new Error(
      'registerMessageBoxPostAuthRoutes requires ctx.liveDelivery; without it HTTP sends are never pushed to sockets'
    )
  }
  const runtime: MessageBoxRuntimeDeps = {
    knex: ctx.knex,
    wallet: ctx.wallet,
    paymentReplayStore: ctx.paymentReplayStore,
    paymentTransactionVerifier: ctx.paymentTransactionVerifier
  }
  router.use((_req, _res, next) => runWithMessageBoxRuntime(runtime, next))
  router.use(canonicalizeAuthenticatedIdentity)
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
        withLiveDelivery(
          ctx.liveDelivery,
          sendMessageRoute.func as unknown as (
            req: ExpressRequest,
            res: Response
          ) => Promise<unknown>
        ) as unknown as RequestHandler
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
  if (ctx.liveDelivery.connections != null) {
    throw new Error('A MessageBoxContext supports one attachMessageBoxWebSockets call')
  }

  Logger.log('[WEBSOCKET] Initializing WebSocket support...')

  const io = new AuthSocketServer(httpServer, createMessageBoxWebSocketOptions(ctx))

  const connections = new WebSocketConnectionRegistry()
  const resources = readMessageBoxResourceConfig()
  const pricing = readMessageBoxPricingConfig()
  const { liveDelivery } = ctx
  liveDelivery.connections = connections
  webSocketState.set(io, { connections, liveDelivery })

  io.on('connection', socket => {
    let activeSendEvents = 0
    const sendRateLimiter = new WebSocketMinuteRateLimiter(resources.webSocketSendRateLimit)
    const controlRateLimiter = new WebSocketMinuteRateLimiter(resources.webSocketControlRateLimit)
    if (
      !connections.register(
        socket,
        () => {
          Logger.log('[WEBSOCKET] Disconnected.')
        },
        resources.webSocketMaxConnections
      )
    ) {
      Logger.warn('[WEBSOCKET] Rejected connection above the process limit.')
      socket.ioSocket.disconnect(true)
      return
    }
    Logger.log('[WEBSOCKET] New connection established.')

    // Handle immediate authentication if identityKey is available
    if (typeof socket.identityKey === 'string' && socket.identityKey.trim() !== '') {
      try {
        const identityKey = authenticatedWebSocketIdentity(socket.identityKey)
        Logger.log('[DEBUG] Parsed WebSocket identity key successfully.')

        if (
          !connections.authenticate(
            socket.id,
            identityKey,
            resources.webSocketMaxConnectionsPerIdentity
          )
        ) {
          throw new WebSocketPolicyError('WebSocket identity connection limit exceeded')
        }
        Logger.log('[WEBSOCKET] Authenticated connection registered.')

        // Send confirmation immediately if identity key is provided on connection
        void socket.emit('authenticationSuccess', { status: 'success' })
      } catch {
        Logger.error('[ERROR] Failed to parse WebSocket identity key.')
        socket.ioSocket.disconnect(true)
      }
    } else {
      // The first signed application event completes BRC-103 peer discovery.
      // The claimed key in the payload is never trusted as an identity source.
      Logger.log('[WEBSOCKET] Waiting for the first authenticated BRC-103 event...')

      let identityKeyHandled = false

      const authListener = async (data: { identityKey?: string }): Promise<void> => {
        if (identityKeyHandled) return
        identityKeyHandled = true

        try {
          const identityKey = authenticatedWebSocketIdentity(socket.identityKey, data?.identityKey)
          if (
            !connections.authenticate(
              socket.id,
              identityKey,
              resources.webSocketMaxConnectionsPerIdentity
            )
          ) {
            throw new WebSocketPolicyError('WebSocket identity connection limit exceeded')
          }

          Logger.log('[WEBSOCKET] BRC-103 peer authenticated.')

          // Emit authentication success message
          await socket.emit('authenticationSuccess', { status: 'success' }).catch(() => {
            Logger.error('[WEBSOCKET ERROR] Failed to send authentication success event.')
          })
        } catch (error) {
          Logger.warn('[WEBSOCKET] Rejected an invalid authenticated peer or identity claim.')
          await socket
            .emit('authenticationFailed', {
              reason:
                error instanceof WebSocketPolicyError
                  ? error.reason
                  : 'Invalid authenticated identity key'
            })
            .catch(() => undefined)
          socket.ioSocket.disconnect(true)
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
        if (!sendRateLimiter.consume()) {
          await socket.emit('messageFailed', {
            reason: 'WebSocket send rate limit exceeded',
            code: 'ERR_WEBSOCKET_RATE_LIMITED'
          })
          return
        }

        if (typeof data !== 'object' || data == null) {
          Logger.error('[WEBSOCKET ERROR] Invalid data object received.')
          await socket.emit('messageFailed', { reason: 'Invalid data object' })
          return
        }

        const { roomId, message } = data

        if (!connections.isAuthenticated(socket.id)) {
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

        activeSendEvents += 1

        try {
          const validationFailure = validateWebSocketMessage(
            roomId,
            message,
            resources.maxMessageBodyBytes
          )
          if (validationFailure != null) {
            Logger.error('[WEBSOCKET ERROR] Rejected invalid sendMessage event.')
            await socket.emit('messageFailed', { reason: validationFailure.reason })
            return
          }

          const messageBoxType = messageBoxFromRecipientRoom(message.recipient, roomId)
          if (messageBoxType == null) {
            await socket.emit('messageFailed', {
              reason: 'Room does not match recipient and message box'
            })
            return
          }

          Logger.log('[WEBSOCKET] Processing sendMessage event.')

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
          await runWithMessageBoxRuntime(
            {
              knex: ctx.knex,
              wallet: ctx.wallet,
              paymentReplayStore: ctx.paymentReplayStore,
              paymentTransactionVerifier: ctx.paymentTransactionVerifier
            },
            async () =>
              await sendMessageRoute.func(
                {
                  auth: { identityKey: connections.identityKey(socket.id) },
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

          await deliverLiveMessage(connections, {
            sender: connections.identityKey(socket.id),
            recipient: message.recipient,
            roomId,
            messageId: message.messageId,
            body: message.body
          })
          Logger.log('[WEBSOCKET] Delivered message notification to authenticated recipients.')
        } catch {
          Logger.error('[WEBSOCKET ERROR] Unexpected failure in sendMessage handler.')
          await socket.emit('messageFailed', { reason: 'Unexpected error occurred' })
        } finally {
          activeSendEvents -= 1
        }
      }
    )

    // Handle joining/leaving rooms
    socket.on('joinRoom', async (roomId: string) => {
      // Named on every refusal a client can correlate: it may have several
      // joins in flight and the event is the only reply it gets.
      const named = typeof roomId === 'string' && roomId.trim() !== '' ? { roomId } : {}
      if (!controlRateLimiter.consume()) {
        await socket.emit('joinFailed', {
          ...named,
          reason: 'WebSocket control-event rate limit exceeded',
          code: 'ERR_WEBSOCKET_CONTROL_RATE_LIMITED'
        })
        return
      }

      if (!connections.isAuthenticated(socket.id)) {
        Logger.warn('[WEBSOCKET] Unauthorized attempt to join a room.')
        await socket.emit('joinFailed', {
          ...named,
          reason: 'Unauthorized: WebSocket not authenticated',
          code: 'ERR_WEBSOCKET_NOT_AUTHENTICATED'
        })
        return
      }

      if (roomId == null || typeof roomId !== 'string' || roomId.trim() === '') {
        Logger.error('[WEBSOCKET ERROR] Invalid roomId.')
        await socket.emit('joinFailed', {
          reason: 'Invalid room ID',
          code: 'ERR_WEBSOCKET_INVALID_ROOM'
        })
        return
      }

      const identityKey = connections.identityKey(socket.id)
      if (identityKey == null || !isIdentityOwnedRoom(identityKey, roomId)) {
        Logger.warn("[WEBSOCKET] Rejected an attempt to join another identity's room.")
        await socket.emit('joinFailed', {
          ...named,
          reason: 'Room is not owned by authenticated identity',
          code: 'ERR_WEBSOCKET_ROOM_NOT_OWNED'
        })
        return
      }

      if (!connections.join(socket.id, roomId, resources.webSocketMaxRoomsPerConnection)) {
        await socket.emit('joinFailed', {
          ...named,
          reason: 'WebSocket room limit exceeded',
          code: 'ERR_WEBSOCKET_ROOM_LIMIT'
        })
        return
      }
      Logger.log('[WEBSOCKET] Authenticated connection joined a room.')
      await socket.emit('joinedRoom', { roomId })
    })

    socket.on('leaveRoom', async (roomId: string) => {
      if (!controlRateLimiter.consume()) {
        await socket.emit('leaveFailed', {
          reason: 'WebSocket control-event rate limit exceeded',
          code: 'ERR_WEBSOCKET_CONTROL_RATE_LIMITED'
        })
        return
      }

      if (!connections.isAuthenticated(socket.id)) {
        Logger.warn('[WEBSOCKET] Unauthorized attempt to leave a room.')
        await socket.emit('leaveFailed', { reason: 'Unauthorized: WebSocket not authenticated' })
        return
      }

      if (roomId == null || roomId === '' || typeof roomId !== 'string' || roomId.trim() === '') {
        Logger.error('[WEBSOCKET ERROR] Invalid roomId.')
        await socket.emit('leaveFailed', { reason: 'Invalid room ID' })
        return
      }

      const identityKey = connections.identityKey(socket.id)
      if (identityKey == null || !isIdentityOwnedRoom(identityKey, roomId)) {
        Logger.warn("[WEBSOCKET] Rejected an attempt to leave another identity's room.")
        await socket.emit('leaveFailed', { reason: 'Room is not owned by authenticated identity' })
        return
      }

      connections.leave(socket.id, roomId)
      Logger.log('[WEBSOCKET] Authenticated connection left a room.')
      await socket.emit('leftRoom', { roomId })
    })
  })

  return io
}
