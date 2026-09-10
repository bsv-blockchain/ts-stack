import express from 'express'
import bodyParser from 'body-parser'
import rateLimit from 'express-rate-limit'
import { InfoController } from './controllers/InfoController'
import { AuthController } from './controllers/AuthController'
import { UserController } from './controllers/UserController'
import { FaucetController } from './controllers/FaucetController'
import { AccountDeletionController } from './controllers/AccountDeletionController'
import { ShareController } from './controllers/ShareController'
import { AdminController } from './controllers/AdminController'
import { DemoAccountController } from './controllers/DemoAccountController'
import { isDemoAuthEnabled } from './services/DemoAccountService'
import { PhoneChangeController } from './controllers/PhoneChangeController'
import { RegistrationController } from './controllers/RegistrationController'
import { requireWABAdmin } from './security/adminAuth'
import { configureTrustProxy, rateLimitOptions } from './security/rateLimitPolicy'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  corsPolicy,
  initialDoubleSlashCompatibility,
  profileValue,
  readBodyLimitBytes,
  readResourceProfile,
  responseSizeLimit,
  securityHeaders
} from './security/edgePolicy'

const app = express()
const resourceProfile = readResourceProfile('WAB')
app.disable('x-powered-by')
configureTrustProxy(app)
app.use(initialDoubleSlashCompatibility)
app.use(securityHeaders({ environmentPrefix: 'WAB' }))
app.use(
  corsPolicy({
    environmentPrefix: 'WAB',
    methods: ['GET', 'POST', 'OPTIONS']
  })
)
app.use(
  concurrencyLimit(
    'WAB',
    profileValue(resourceProfile, {
      small: 64,
      standard: 128,
      highThroughput: 256
    })
  )
)
app.use(rateLimit(rateLimitOptions('WAB_PRE_AUTH_RATE_LIMIT', { windowMs: 60_000, limit: 300 })))
app.use(
  bodyParser.json({
    limit: readBodyLimitBytes(
      'WAB',
      profileValue(resourceProfile, {
        small: 128 * 1024,
        standard: 256 * 1024,
        highThroughput: 1024 * 1024
      })
    )
  })
)
app.use(bodyParserErrorHandler)
app.use(
  responseSizeLimit(
    'WAB',
    profileValue(resourceProfile, {
      small: 1024 * 1024,
      standard: 2 * 1024 * 1024,
      highThroughput: 8 * 1024 * 1024
    })
  )
)

const authenticationLimiter = rateLimit(
  rateLimitOptions('WAB_AUTH_RATE_LIMIT', { windowMs: 15 * 60 * 1000, limit: 10 })
)

const accountDeletionLimiter = rateLimit(
  rateLimitOptions('WAB_ACCOUNT_DELETION_RATE_LIMIT', { windowMs: 15 * 60 * 1000, limit: 5 })
)

const userOperationLimiter = rateLimit(
  rateLimitOptions('WAB_USER_RATE_LIMIT', { windowMs: 15 * 60 * 1000, limit: 120 })
)

const faucetLimiter = rateLimit(
  rateLimitOptions('WAB_FAUCET_RATE_LIMIT', { windowMs: 60 * 60 * 1000, limit: 5 })
)

const shareLimiter = rateLimit(
  rateLimitOptions('WAB_SHARE_RATE_LIMIT', { windowMs: 15 * 60 * 1000, limit: 10 })
)

const adminLimiter = rateLimit(
  rateLimitOptions('WAB_ADMIN_RATE_LIMIT', { windowMs: 15 * 60 * 1000, limit: 30 })
)

// Info route
app.get('/healthz', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    ok: true,
    status: 'ok',
    service: 'wab-server',
    network: process.env.BSV_NETWORK ?? 'mainnet',
    profile: resourceProfile
  })
})
app.get('/info', InfoController.getInfo)

// Existing clients can choose this WAB base URL to automatically select the
// distinct demo method. Reuse the same limiters on both public entry points.
app.use('/demo', (req, res, next) => {
  if (!isDemoAuthEnabled()) {
    res.status(404).json({ message: 'Not found.' })
    return
  }
  if (req.path === '/info' && req.method === 'GET') {
    res.json({ supportedAuthMethods: ['DemoPhone'], faucetEnabled: true, faucetAmount: 1000 })
    return
  }
  // Older phone interactors send TwilioPhone regardless of discovery. On this
  // explicit demo base URL only, translate that wire alias to the demo namespace.
  if (req.body?.methodType === 'TwilioPhone') req.body.methodType = 'DemoPhone'
  if (req.body?.methodType !== undefined && req.body.methodType !== 'DemoPhone') {
    res.status(400).json({ message: 'The demo endpoint requires DemoPhone authentication.' })
    return
  }
  next()
})
app.post('/demo/auth/start', authenticationLimiter, AuthController.startAuth)
app.post('/demo/auth/complete', authenticationLimiter, AuthController.completeAuth)
app.post('/demo/faucet/request', faucetLimiter, FaucetController.requestFaucet)
app.post('/demo/user/linkedMethods', userOperationLimiter, UserController.listLinkedMethods)
app.post('/demo/user/unlinkMethod', userOperationLimiter, UserController.unlinkMethod)
app.post('/demo/user/delete', userOperationLimiter, UserController.deleteUser)
app.post(
  '/demo/account/delete/start',
  accountDeletionLimiter,
  AccountDeletionController.startDeletion
)
app.post(
  '/demo/account/delete/complete',
  accountDeletionLimiter,
  AccountDeletionController.completeDeletion
)
app.post('/demo/share/store', shareLimiter, ShareController.storeShare)
app.post('/demo/share/retrieve', shareLimiter, ShareController.retrieveShare)
app.post('/demo/share/update', shareLimiter, ShareController.updateShare)
app.post('/demo/share/delete', shareLimiter, ShareController.deleteUser)

// Auth routes
app.post('/auth/start', authenticationLimiter, AuthController.startAuth)
app.post('/auth/complete', authenticationLimiter, AuthController.completeAuth)
app.post('/auth/registration/finalize', authenticationLimiter, RegistrationController.finalize)
app.post('/auth/phone-change/start', authenticationLimiter, PhoneChangeController.start)
app.post('/auth/phone-change/complete', authenticationLimiter, PhoneChangeController.complete)
app.post('/auth/phone-change/commit', authenticationLimiter, PhoneChangeController.commit)
app.post('/auth/phone-change/finalize', authenticationLimiter, PhoneChangeController.finalize)

// Administrative support routes are unavailable unless WAB_ADMIN_TOKEN is set.
app.post('/admin/demo-accounts', adminLimiter, requireWABAdmin, DemoAccountController.manage)
app.post('/admin/ump-pin', adminLimiter, requireWABAdmin, AdminController.setUMPTokenPin)
app.post(
  '/admin/registration/reopen',
  adminLimiter,
  requireWABAdmin,
  AdminController.reopenRegistration
)
app.post(
  '/admin/phone-change/restore',
  adminLimiter,
  requireWABAdmin,
  AdminController.restorePhoneChange
)

// Account deletion routes (for users who can't access their account)
// Rate limited to prevent SMS spam and brute-force attacks
app.post('/account/delete/start', accountDeletionLimiter, AccountDeletionController.startDeletion)
app.post(
  '/account/delete/complete',
  accountDeletionLimiter,
  AccountDeletionController.completeDeletion
)

// User routes
app.post('/user/linkedMethods', userOperationLimiter, UserController.listLinkedMethods)
app.post('/user/unlinkMethod', userOperationLimiter, UserController.unlinkMethod)
app.post('/user/delete', userOperationLimiter, UserController.deleteUser)

// Faucet route
app.post('/faucet/request', faucetLimiter, FaucetController.requestFaucet)

// Shamir share routes (for 2-of-3 key recovery system)
// Rate limited to prevent brute-force OTP attacks and share enumeration
app.post('/share/store', shareLimiter, ShareController.storeShare)
app.post('/share/retrieve', shareLimiter, ShareController.retrieveShare)
app.post('/share/update', shareLimiter, ShareController.updateShare)
app.post('/share/delete', shareLimiter, ShareController.deleteUser)

export default app
