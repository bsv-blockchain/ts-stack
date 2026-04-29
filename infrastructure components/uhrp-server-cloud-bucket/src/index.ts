import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import bodyparser from 'body-parser'
import prettyjson from 'prettyjson'
import { PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { getWallet } from './utils/walletSingleton'
import routes from './routes'
import getPriceForFile from './utils/getPriceForFile'
import { getMetadata } from './utils/getMetadata'

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as string
const HTTP_PORT = process.env.HTTP_PORT || 8080

const app = express()
app.use(bodyparser.json({ limit: '1gb', type: 'application/json' }))

// This allows the API to be used when CORS is enforced
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', '*')
  res.header('Access-Control-Allow-Methods', '*')
  res.header('Access-Control-Expose-Headers', '*')
  res.header('Access-Control-Allow-Private-Network', 'true')
  if (req.method === 'OPTIONS') {
    res.send(200)
  } else {
    next()
  }
})

app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[${req.method}] <- ${req.url}`);
  const logObject = { ...req.body }
  console.log(prettyjson.render(logObject, { keysColor: 'blue' }))
  const originalJson = res.json.bind(res)
  res.json = (json: any) => {
    console.log(`[${req.method}] -> ${req.url}`)
    console.log(prettyjson.render(json, { keysColor: 'green' }))
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
  console.log(`adding pre-auth route ${route.path}`)
  // If we need middleware for a route, attach it
  if ((route as any).middleware) {
    app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](
      route.path,
      (route as any).middleware,
      (route as any).func
    )
  } else {
    app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](route.path, (route as any).func)
  }
})

// This ensures that HTTPS is used for uploads
app.use((req: Request, res: Response, next: NextFunction) => {
  if (
    !req.secure &&
    req.get('x-forwarded-proto') !== 'https'
  ) {
    return res.redirect('https://' + req.get('host') + req.url)
  }
  next()
});

// Secured pre-auth routes are added after the HTTPS redirect
preAuthRoutes.filter(route => !(route as any).unsecured).forEach((route) => {
  console.log(`adding route ${route.path} https required`)
  // If we need middleware for a route, attach it
  if ((route as any).middleware) {
    app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](
      route.path,
      (route as any).middleware,
      (route as any).func
    )
  } else {
    app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](route.path, (route as any).func)
  }
})

  // Auth is enforced from here forward
  ; (async () => {
    const wallet = await getWallet()
    const authMiddleware = createAuthMiddleware({
      wallet,
      allowUnauthenticated: true
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
          } catch (e) {
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
          } catch (e) {
            return 0
          }
        }

        return 0
      }
    })

    app.use(authMiddleware);
    app.use(paymentMiddleware)

    // Secured, post-auth routes are added
    postAuthRoutes.forEach((route) => {
      console.log(`adding https post-auth route ${route.path}`)
      // If we need middleware for a route, attach it
      if ((route as any).middleware) {
        app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](
          route.path,
          (route as any).middleware,
          (route as any).func
        )
      } else {
        app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](route.path, (route as any).func)
      }
    })

    app.use((req, res) => {
      console.log('404', req.url)
      res.status(404).json({
        status: 'error',
        code: 'ERR_ROUTE_NOT_FOUND',
        description: 'Route not found.'
      })
    })

    app.listen(HTTP_PORT, () => {
      console.log('UHRP Storage Server listening on port', HTTP_PORT)

      const identityKey = PrivateKey
        .fromString(SERVER_PRIVATE_KEY).toPublicKey().toString()
      console.log(`UHRP Host Identity Key: ${identityKey}`)
    })

  })();