/**
 * @file index.ts
 * @description
 * Main entry point for the MessageBox Server.
 *
 * Responsibilities:
 * - Initializes environment variables and config
 * - Creates HTTP and WebSocket servers
 * - Boots authentication and route handlers
 * - Sets up database migrations after a short delay
 * - Emits and handles real-time message events over WebSocket
 *
 * Exports:
 * - `start()` for programmatic bootstrapping
 * - `http` and `io` server instances
 * - `HTTP_PORT` and `ROUTING_PREFIX` for external reference
 */

import * as dotenv from 'dotenv'
import { app, appReady, getWallet, knex } from './app.js'
import { spawn } from 'child_process'
import { createServer } from 'http'
import { PublicKey } from '@bsv/sdk'
import { Logger } from './utils/logger.js'
import { AuthSocketServer } from '@bsv/authsocket'
import * as crypto from 'crypto'
import { initializeFirebase } from './config/firebase.js'
(global.self as any) = { crypto }

dotenv.config()

// Load environment variables
const {
  NODE_ENV = 'development',
  PORT,
  SERVER_PRIVATE_KEY,
  ENABLE_WEBSOCKETS = 'true',
  ROUTING_PREFIX = ''
} = process.env

// if (NODE_ENV === 'development' || process.env.LOGGING_ENABLED === 'true') {
//   Logger.enable()
// }
Logger.enable()
// Determine which port to listen on
const parsedPort = Number(PORT)
const parsedEnvPort = Number(process.env.HTTP_PORT)

const HTTP_PORT: number = NODE_ENV !== 'development'
  ? 3000
  : !isNaN(parsedPort) && parsedPort > 0
    ? parsedPort
    : !isNaN(parsedEnvPort) && parsedEnvPort > 0
      ? parsedEnvPort
      : 8080

// Ensure private key is available before proceeding
if (SERVER_PRIVATE_KEY === undefined || SERVER_PRIVATE_KEY === null || SERVER_PRIVATE_KEY.trim() === '') {
  throw new Error('SERVER_PRIVATE_KEY is not defined in the environment variables.')
}

// Initialize Firebase Admin (only when ENABLE_FIREBASE=true)
initializeFirebase()

// Create HTTP server
/* eslint-disable @typescript-eslint/no-misused-promises */
const http = createServer(app)

// WebSocket setup (only if enabled)
let io: AuthSocketServer | null = null

/**
 * @function start
 * @description
 * Initializes the WebSocket server with identity-key-based authentication
 * and attaches all supported event handlers for:
 * - `sendMessage`
 * - `joinRoom`
 * - `leaveRoom`
 * - `disconnect`
 *
 * Only runs if `ENABLE_WEBSOCKETS` is set to `true` in the environment.
 *
 * @returns {Promise<void>} Resolves once WebSocket listeners are fully attached.
 */
export const start = async (): Promise<void> => {
  await appReady

  if (ENABLE_WEBSOCKETS.toLowerCase() === 'true') {
    Logger.log('[WEBSOCKET] Initializing WebSocket support...')
    io = new AuthSocketServer(http, {
      wallet: await getWallet(),
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    })

    // Map to store authenticated identity keys
    const authenticatedSockets = new Map<string, string>()

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

            if (io != null) {
              Logger.log(`[WEBSOCKET] Emitting message to room ${roomId}`)
              io.emit(`sendMessage-${roomId}`, {
                sender: authenticatedSockets.get(socket.id),
                messageId: message.messageId,
                body: message.body
              })
            } else {
              Logger.error('[WEBSOCKET ERROR] io is null, cannot emit message.')
            }
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
  }
}

// Export for testing and CLI use
export { io, http, HTTP_PORT, ROUTING_PREFIX }

// Only run server if not in test mode
if (NODE_ENV !== 'test') {
  http.listen(HTTP_PORT, () => {
    Logger.log('MessageBox listening on port', HTTP_PORT)

      // if (
      //   NODE_ENV !== 'development' &&
      //   process.env.SKIP_NGINX !== 'true'
      // ) {
      //   spawn('nginx', [], { stdio: ['inherit', 'inherit', 'inherit'] })
      // }

      // Run DB migrations immediately, no delay needed with container healthchecks
      ; (async () => {
        await knex.migrate.latest()
      })().catch((error) => {
        Logger.error('[STARTUP ERROR]', error)
      })
  })

  start().catch(error => {
    Logger.error('[SERVER INIT ERROR]', error)
  })
}
