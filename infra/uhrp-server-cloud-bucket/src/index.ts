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
  initialDoubleSlashCompatibility,
  profileValue,
  readBodyLimitBytes,
  readResourceLimit,
  readResourceProfile,
  responseSizeLimit,
  securityHeaders
} from './security/edgePolicy'
import { createServiceHealth } from './serviceHealth'

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as string
const HTTP_PORT = process.env.HTTP_PORT || 8080
const NODE_ENV = process.env.NODE_ENV || 'development'
type HttpRouteMethod = 'get' | 'put' | 'post' | 'patch' | 'delete'

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
const resourceProfile = readResourceProfile('UHRP')
const serviceHealth = createServiceHealth()
app.disable('x-powered-by')
configureTrustProxy(app)
app.use(initialDoubleSlashCompatibility)
app.use(securityHeaders({ environmentPrefix: 'UHRP' }))
app.use(corsPolicy({
  environmentPrefix: 'UHRP',
  methods: ['GET', 'POST', 'OPTIONS']
}))
app.use(concurrencyLimit('UHRP', profileValue(resourceProfile, {
  small: 16,
  standard: 64,
  highThroughput: 250
})))
serviceHealth.register(app)
app.use(preAuthRateLimit)
app.use(bodyparser.json({
  limit: readBodyLimitBytes('UHRP_JSON', 256 * 1024),
  type: 'application/json'
}))
app.use(bodyParserErrorHandler)
const maxResponseBytes = readResourceLimit(
  'UHRP',
  'MAX_RESPONSE_BYTES',
  profileValue(resourceProfile, {
    small: 1024 * 1024,
    standard: 4 * 1024 * 1024,
    highThroughput: 16 * 1024 * 1024
  })
)
app.use(responseSizeLimit('UHRP', maxResponseBytes))

app.use((req: Request, res: Response, next: NextFunction) => {
  log.info({ operation: 'request.in', method: req.method, url: req.url }, 'Incoming request')
  const originalJson = res.json.bind(res)
  res.json = (json: any) => {
    log.info({ operation: 'response.json', method: req.method, url: req.url }, 'Outgoing JSON response')
    return originalJson(json)
  }
  next()
})

app.use(express.static('public'))

// Unsecured pre-auth routes are added first
const preAuthRoutes = Object.values(routes.preAuth);
const postAuthRoutes = Object.values(routes.postAuth);

// Cycle through pre-auth routes
preAuthRoutes.filter(route => (route as any).unsecured).forEach((route) => {
  log.info({ operation: 'route.register', phase: 'pre_auth', secured: false, route_path: route.path }, 'Registering route')
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

// This ensures that HTTPS is used for uploads
app.use((req: Request, res: Response, next: NextFunction) => {
  if (NODE_ENV === 'production' && !req.secure) {
    return res.status(426).json({
      status: 'error',
      code: 'ERR_HTTPS_REQUIRED',
      description: 'HTTPS is required for this route.'
    })
  }
  next()
});

// Secured pre-auth routes are added after the HTTPS redirect
preAuthRoutes.filter(route => !(route as any).unsecured).forEach((route) => {
  log.info({ operation: 'route.register', phase: 'pre_auth', secured: true, route_path: route.path }, 'Registering route')
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
    // Re-apply after auth response interception so signed responses remain
    // bounded with every compatible auth-middleware release.
    app.use(responseSizeLimit('UHRP', maxResponseBytes))
    app.use(authenticatedRateLimit)
    app.use(paymentMiddleware)

    // Secured, post-auth routes are added
    postAuthRoutes.forEach((route) => {
      log.info({ operation: 'route.register', phase: 'post_auth', secured: true, route_path: route.path }, 'Registering route')
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
      log.warn({ operation: 'route.not_found', method: req.method, url: req.url }, 'Route not found')
      res.status(404).json({
        status: 'error',
        code: 'ERR_ROUTE_NOT_FOUND',
        description: 'Route not found.'
      })
    })

    serviceHealth.markReady()
    const server = app.listen(HTTP_PORT, () => {
      const identityKey = PrivateKey
        .fromString(SERVER_PRIVATE_KEY).toPublicKey().toString()
      log.info(
        { operation: 'listen', outcome: 'ok', port: HTTP_PORT, identity_key: identityKey },
        'UHRP Storage Server listening'
      )
    })
    configureHttpServer(server, 'UHRP', {
      requestTimeoutMs: 60_000,
      headersTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
      socketTimeoutMs: 60_000,
      maxRequestsPerSocket: 1_000
    })

    let stopping: Promise<void> | undefined
    const stopCloudService = (signal: NodeJS.Signals): Promise<void> => {
      stopping ??= new Promise<void>((resolve, reject) => {
        serviceHealth.markNotReady()
        log.info({ operation: 'shutdown', signal }, 'UHRP cloud-bucket shutdown started')
        server.close(error => error == null ? resolve() : reject(error))
      })
        .then(async () => {
          await destroyWallet()
          log.info(
            { operation: 'shutdown', outcome: 'ok', signal },
            'UHRP cloud-bucket shutdown complete'
          )
        })
        .catch(error => {
          process.exitCode = 1
          log.error(
            { operation: 'shutdown', outcome: 'error', signal, err: error },
            'UHRP cloud-bucket shutdown failed'
          )
        })
      return stopping
    }
    process.once('SIGTERM', () => void stopCloudService('SIGTERM'))
    process.once('SIGINT', () => void stopCloudService('SIGINT'))

  })().catch((error) => {
    log.error({ operation: 'bootstrap', outcome: 'error', err: error }, 'UHRP Storage Server failed to start')
    process.exit(1)
  });
