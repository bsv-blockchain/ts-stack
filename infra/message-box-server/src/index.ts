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
import { createServer } from 'node:http'
import { Logger, log } from './utils/logger.js'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { createMessageBoxContext, attachMessageBoxWebSockets } from './compose.js'
import { AuthSocketServer } from '@bsv/authsocket'
import * as crypto from 'node:crypto'
import { initializeFirebase } from './config/firebase.js'
import { configureHttpServer } from './security/edgePolicy.js'
import { resolveHttpPort } from './config/runtime.js'
;(global.self as any) = { crypto }

dotenv.config()

// Load environment variables
const {
  NODE_ENV = 'development',
  SERVER_PRIVATE_KEY,
  ENABLE_WEBSOCKETS = 'true',
  ROUTING_PREFIX = ''
} = process.env

if (NODE_ENV === 'development' || process.env.LOGGING_ENABLED === 'true') {
  Logger.enable()
}

const HTTP_PORT = resolveHttpPort()

// Ensure private key is available before proceeding
if (
  SERVER_PRIVATE_KEY === undefined ||
  SERVER_PRIVATE_KEY === null ||
  SERVER_PRIVATE_KEY.trim() === ''
) {
  throw new Error('SERVER_PRIVATE_KEY is not defined in the environment variables.')
}

// Initialize Firebase Admin (only when ENABLE_FIREBASE=true)
initializeFirebase()

// Create HTTP server
/* eslint-disable @typescript-eslint/no-misused-promises */
const http = createServer(app)
configureHttpServer(http, 'MESSAGE_BOX', {
  requestTimeoutMs: 60_000,
  headersTimeoutMs: 15_000,
  keepAliveTimeoutMs: 5_000,
  socketTimeoutMs: 60_000,
  maxRequestsPerSocket: 1_000
})

// WebSocket setup (only if enabled)
// Held in a const container so the exported binding is never reassigned.
const ioRef: { current: AuthSocketServer | null } = { current: null }

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
    const wallet = await getWallet()
    const ctx = createMessageBoxContext({
      wallet,
      knex,
      enableWebSockets: true
    })
    ioRef.current = attachMessageBoxWebSockets(http, ctx)
  }
}

// Export for testing and CLI use.
// `ioRef` is a const container; the live WebSocket server is at `ioRef.current`.
export { ioRef as io, http, HTTP_PORT, ROUTING_PREFIX }

export async function startStandalone(): Promise<void> {
  const tracer = trace.getTracer('@bsv/messagebox-server')
  await tracer.startActiveSpan('messagebox.migrate', async span => {
    const startedAt = Date.now()
    try {
      await knex.migrate.latest()
      span.setStatus({ code: SpanStatusCode.OK })
      log.info(
        { operation: 'migrate', outcome: 'ok', duration_ms: Date.now() - startedAt },
        'migrations applied'
      )
    } catch (error) {
      span.recordException(error as Error)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Migration failed'
      })
      throw error
    } finally {
      span.end()
    }
  })

  await start()
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(HTTP_PORT, () => {
      http.off('error', reject)
      log.info({ operation: 'listen', outcome: 'ok', port: HTTP_PORT }, 'MessageBox listening')
      resolve()
    })
  })
}

// Migrations, wallet/auth setup, and WebSocket policy must all be ready before
// the service accepts traffic. A failed prerequisite is a failed process, not
// a partially healthy server.
if (NODE_ENV !== 'test') {
  try {
    await startStandalone()
  } catch (error) {
    log.error({ operation: 'server.init', outcome: 'error', err: error }, '[SERVER INIT ERROR]')
    try {
      await knex.destroy()
    } catch (shutdownError) {
      log.error(
        { operation: 'server.shutdown', outcome: 'error', err: shutdownError },
        'Failed to close the database pool after initialization failure'
      )
    }
    process.exitCode = 1
  }
}

// Composable API for embedding (standalone boot above is unchanged)
export {
  createMessageBoxContext,
  createMessageBoxApp,
  bindMessageBoxRuntime,
  registerMessageBoxPreAuthRoutes,
  registerMessageBoxPostAuthRoutes,
  attachMessageBoxWebSockets
} from './compose.js'
export type { MessageBoxContext, CreateMessageBoxContextOptions } from './context.js'
export type { MessageBoxRouter } from './compose.js'
