/**
 * Binary entry: env → context → mount → listen.
 * For in-process mounting, import from compose.js instead.
 */

import * as dotenv from 'dotenv'
import { createServer } from 'http'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import * as crypto from 'crypto'
import {
  createMessageBoxContext,
  createMessageBoxApp,
  mountMessageBoxRoutes,
  attachMessageBoxWebSockets
} from './compose.js'
import { createKnexFromEnv, createWalletFromEnv } from './app.js'
import { Logger, log } from './utils/logger.js'
import { initializeFirebase } from './config/firebase.js'
;(global.self as any) = { crypto }

dotenv.config()

const {
  NODE_ENV = 'development',
  PORT,
  SERVER_PRIVATE_KEY,
  ENABLE_WEBSOCKETS = 'true',
  ROUTING_PREFIX = ''
} = process.env

Logger.enable()

const parsedPort = Number(PORT)
const parsedEnvPort = Number(process.env.HTTP_PORT)

export const HTTP_PORT: number = NODE_ENV !== 'development'
  ? 3000
  : !Number.isNaN(parsedPort) && parsedPort > 0
    ? parsedPort
    : !Number.isNaN(parsedEnvPort) && parsedEnvPort > 0
      ? parsedEnvPort
      : 8080

export const ROUTING_PREFIX_VALUE = ROUTING_PREFIX

if (SERVER_PRIVATE_KEY === undefined || SERVER_PRIVATE_KEY === null || SERVER_PRIVATE_KEY.trim() === '') {
  throw new Error('SERVER_PRIVATE_KEY is not defined in the environment variables.')
}

initializeFirebase()

const knex = createKnexFromEnv()
const app = createMessageBoxApp()

const ioRef: { current: ReturnType<typeof attachMessageBoxWebSockets> } = { current: null }
export const http = createServer(app)

export { ioRef as io, ROUTING_PREFIX }

export async function start (): Promise<void> {
  const wallet = await createWalletFromEnv()
  const ctx = createMessageBoxContext({
    wallet,
    knex,
    routingPrefix: ROUTING_PREFIX,
    enableWebSockets: ENABLE_WEBSOCKETS.toLowerCase() === 'true'
  })

  mountMessageBoxRoutes(app, ctx)
  ioRef.current = attachMessageBoxWebSockets(http, ctx)
}

// Re-export composable API for consumers who import the package entry
export {
  createMessageBoxContext,
  createMessageBoxApp,
  mountMessageBoxRoutes,
  attachMessageBoxWebSockets
} from './compose.js'
export type { MessageBoxContext, CreateMessageBoxContextOptions } from './context.js'

if (NODE_ENV !== 'test') {
  const tracer = trace.getTracer('@bsv/messagebox-server')

  start()
    .then(() => {
      http.listen(HTTP_PORT, () => {
        log.info({ operation: 'listen', outcome: 'ok', port: HTTP_PORT }, 'MessageBox listening')

        tracer.startActiveSpan('messagebox.migrate', async (span) => {
          const startedAt = Date.now()
          try {
            await knex.migrate.latest()
            span.setStatus({ code: SpanStatusCode.OK })
            log.info({ operation: 'migrate', outcome: 'ok', duration_ms: Date.now() - startedAt }, 'migrations applied')
          } catch (error) {
            span.recordException(error as Error)
            span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
            log.error({ operation: 'migrate', outcome: 'error', err: error }, '[STARTUP ERROR] migrations failed')
          } finally {
            span.end()
          }
        })
      })
    })
    .catch(error => {
      log.error({ operation: 'server.init', outcome: 'error', err: error }, '[SERVER INIT ERROR]')
    })
}
