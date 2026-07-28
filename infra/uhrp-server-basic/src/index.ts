import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import bodyparser from 'body-parser'
import { PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { destroyWallet, getWallet } from './utils/walletSingleton'
import routes from './routes'
import getPriceForFile from './utils/getPriceForFile'
import { getMetadata } from './utils/getMetadata'
import { cdnMimeTypeMiddleware } from './utils/mimeTypeMiddleware'
import path from 'node:path'
import type { Server } from 'node:http'
import { log } from './logger'
import { rateLimit } from 'express-rate-limit'
import {
  authenticatedIdentityKey,
  configureTrustProxy,
  rateLimitOptions
} from './security/rateLimitPolicy'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  configureHttpServer,
  corsPolicy,
  readBodyLimitBytes,
  securityHeaders
} from './security/edgePolicy'
import { createServiceHealth } from './serviceHealth'

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as string
const HTTP_PORT = process.env.HTTP_PORT || 8080
type HttpRouteMethod = 'get' | 'put' | 'post' | 'patch' | 'delete'

const closeHttpServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error == null ? resolve() : reject(error))
  })
}

const preAuthRateLimit = rateLimit(rateLimitOptions(
  'UHRP_PRE_AUTH_RATE_LIMIT',
  { windowMs: 60_000, limit: 300 }
))

const authenticatedRateLimit = rateLimit(rateLimitOptions(
  'UHRP_AUTHENTICATED_RATE_LIMIT',
  { windowMs: 60_000, limit: 1_000 },
  { keyGenerator: authenticatedIdentityKey }
))

const app = express()
const serviceHealth = createServiceHealth()
app.disable('x-powered-by')
configureTrustProxy(app)
app.use(securityHeaders({ environmentPrefix: 'UHRP' }))
app.use(corsPolicy({
  environmentPrefix: 'UHRP',
  methods: ['GET', 'PUT', 'POST', 'OPTIONS']
}))
app.use(concurrencyLimit('UHRP', 100))
serviceHealth.register(app)
app.use(preAuthRateLimit)
// Add CDN MIME type middleware before static middleware
app.use(cdnMimeTypeMiddleware)
app.use(express.static(path.join(__dirname, '../public')))
app.use(bodyparser.json({
  limit: readBodyLimitBytes('UHRP_JSON', 256 * 1024),
  type: 'application/json'
}))
app.use(bodyParserErrorHandler)

app.use((req: Request, res: Response, next: NextFunction) => {
  log.info({ operation: 'request.in', method: req.method, path: req.path }, 'Incoming request')
  const originalJson = res.json.bind(res)
  res.json = (json: any) => {
    log.info({ operation: 'response.out', status_code: res.statusCode }, 'Outgoing JSON response')
    return originalJson(json)
  }
  next()
})

// Unsecured pre-auth routes are added first
const preAuthRoutes = Object.values(routes.preAuth);
const postAuthRoutes = Object.values(routes.postAuth);

// Cycle through pre-auth routes
preAuthRoutes.filter(route => (route as any).unsecured).forEach((route) => {
  log.info({ operation: 'route.register', phase: 'pre_auth_unsecured', route_path: route.path, route_type: route.type }, 'adding route')
  // If we need middleware for a route, attach it
  if ((route as any).middleware) {
    app[route.type as HttpRouteMethod](
      route.path,
      (route as any).middleware,
      (route as any).func
    )
  } else {
    app[route.type as HttpRouteMethod](route.path, (route as any).func)
  }
})

// Secured pre-auth routes are added next
preAuthRoutes.filter(route => !(route as any).unsecured).forEach((route) => {
  log.info({ operation: 'route.register', phase: 'pre_auth_secured', route_path: route.path, route_type: route.type }, 'adding route')
  // If we need middleware for a route, attach it
  if ((route as any).middleware) {
    app[route.type as HttpRouteMethod](
      route.path,
      (route as any).middleware,
      (route as any).func
    )
  } else {
    app[route.type as HttpRouteMethod](route.path, (route as any).func)
  }
})

  // Auth is enforced from here forward
  ; (async () => {
    const wallet = await getWallet()
    const authMiddleware = createAuthMiddleware({
      wallet,
      allowUnauthenticated: false
    })

    const paymentMiddleware = createPaymentMiddleware({
      wallet,
      calculateRequestPrice: async (req) => {
        if (req.url === '/upload') {
          const { fileSize, retentionPeriod } = (req.body as any) || {}
          if (!fileSize || !retentionPeriod) return 0
          try {
            const satoshis = await getPriceForFile({ fileSize: +fileSize, retentionPeriod: +retentionPeriod })
            return satoshis
          } catch {
            return 0
          }
        }
        if (req.url === '/renew') {
          const { uhrpUrl, additionalMinutes } = (req.body as any) || {}
          if (!uhrpUrl || !additionalMinutes) return 0
          try {
            const { size } = await getMetadata(uhrpUrl, (req as any).auth.identityKey)
            const satoshis = await getPriceForFile({ fileSize: +size, retentionPeriod: +additionalMinutes })
            return satoshis
          } catch {
            return 0
          }
        }

        return 0
      }
    })

    app.use(authMiddleware);
    app.use(authenticatedRateLimit)
    app.use(paymentMiddleware)

    // Secured, post-auth routes are added
    postAuthRoutes.forEach((route) => {
      log.info({ operation: 'route.register', phase: 'post_auth', route_path: route.path, route_type: route.type }, 'adding route')
      // If we need middleware for a route, attach it
      if ((route as any).middleware) {
        app[route.type as HttpRouteMethod](
          route.path,
          (route as any).middleware,
          (route as any).func
        )
      } else {
        app[route.type as HttpRouteMethod](route.path, (route as any).func)
      }
    })

    app.use((req, res) => {
      log.info({ operation: 'route.not_found', method: req.method, path: req.path }, 'Route not found')
      res.status(404).json({
        status: 'error',
        code: 'ERR_ROUTE_NOT_FOUND',
        description: 'Route not found.'
      })
    })

    serviceHealth.markReady()
    const server = app.listen(HTTP_PORT, () => {
      const idKey = PrivateKey
        .fromString(SERVER_PRIVATE_KEY).toPublicKey().toString()
      log.info(
        { operation: 'listen', outcome: 'ok', port: HTTP_PORT, identity_key: idKey },
        'UHRP Storage Server listening'
      )
    })
    configureHttpServer(server, 'UHRP', {
      requestTimeoutMs: 5 * 60 * 1000,
      headersTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
      socketTimeoutMs: 5 * 60 * 1000,
      maxRequestsPerSocket: 1_000
    })

    let shutdownPromise: Promise<void> | undefined
    const shutdown = (signal: NodeJS.Signals): Promise<void> => {
      shutdownPromise ??= (async () => {
        serviceHealth.markNotReady()
        log.info({ operation: 'shutdown', signal }, 'UHRP basic shutdown started')
        await closeHttpServer(server)
        await destroyWallet()
        log.info({ operation: 'shutdown', outcome: 'ok', signal }, 'UHRP basic shutdown complete')
      })().catch(error => {
        process.exitCode = 1
        log.error({ operation: 'shutdown', outcome: 'error', signal, err: error }, 'UHRP basic shutdown failed')
      })
      return shutdownPromise
    }
    process.once('SIGTERM', () => void shutdown('SIGTERM'))
    process.once('SIGINT', () => void shutdown('SIGINT'))

  })().catch((error) => {
    log.error({ operation: 'bootstrap', outcome: 'error', err: error }, 'UHRP Storage Server failed to start')
    process.exit(1)
  });
