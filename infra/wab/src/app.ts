import express from "express"
import bodyParser from "body-parser"
import rateLimit from "express-rate-limit"
import { InfoController } from "./controllers/InfoController"
import { AuthController } from "./controllers/AuthController"
import { UserController } from "./controllers/UserController"
import { FaucetController } from "./controllers/FaucetController"
import { AccountDeletionController } from "./controllers/AccountDeletionController"
import { ShareController } from "./controllers/ShareController"
import { configureTrustProxy, rateLimitOptions } from "./security/rateLimitPolicy"
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  corsPolicy,
  readBodyLimitBytes,
  securityHeaders
} from "./security/edgePolicy"

const app = express()
app.disable('x-powered-by')
configureTrustProxy(app)
app.use(securityHeaders({ environmentPrefix: 'WAB' }))
app.use(corsPolicy({
  environmentPrefix: 'WAB',
  methods: ['GET', 'POST', 'OPTIONS']
}))
app.use(concurrencyLimit('WAB', 200))
app.use(rateLimit(rateLimitOptions(
  'WAB_PRE_AUTH_RATE_LIMIT',
  { windowMs: 60_000, limit: 300 }
)))
app.use(bodyParser.json({
  limit: readBodyLimitBytes('WAB', 256 * 1024)
}))
app.use(bodyParserErrorHandler)

const authenticationLimiter = rateLimit(rateLimitOptions(
  'WAB_AUTH_RATE_LIMIT',
  { windowMs: 15 * 60 * 1000, limit: 10 }
))

const accountDeletionLimiter = rateLimit(rateLimitOptions(
  'WAB_ACCOUNT_DELETION_RATE_LIMIT',
  { windowMs: 15 * 60 * 1000, limit: 5 }
))

const userOperationLimiter = rateLimit(rateLimitOptions(
  'WAB_USER_RATE_LIMIT',
  { windowMs: 15 * 60 * 1000, limit: 120 }
))

const faucetLimiter = rateLimit(rateLimitOptions(
  'WAB_FAUCET_RATE_LIMIT',
  { windowMs: 60 * 60 * 1000, limit: 5 }
))

const shareLimiter = rateLimit(rateLimitOptions(
  'WAB_SHARE_RATE_LIMIT',
  { windowMs: 15 * 60 * 1000, limit: 10 }
))

// Info route
app.get("/info", InfoController.getInfo)

// Auth routes
app.post("/auth/start", authenticationLimiter, AuthController.startAuth)
app.post("/auth/complete", authenticationLimiter, AuthController.completeAuth)

// Account deletion routes (for users who can't access their account)
// Rate limited to prevent SMS spam and brute-force attacks
app.post("/account/delete/start", accountDeletionLimiter, AccountDeletionController.startDeletion)
app.post("/account/delete/complete", accountDeletionLimiter, AccountDeletionController.completeDeletion)

// User routes
app.post("/user/linkedMethods", userOperationLimiter, UserController.listLinkedMethods)
app.post("/user/unlinkMethod", userOperationLimiter, UserController.unlinkMethod)
app.post("/user/delete", userOperationLimiter, UserController.deleteUser)

// Faucet route
app.post("/faucet/request", faucetLimiter, FaucetController.requestFaucet)

// Shamir share routes (for 2-of-3 key recovery system)
// Rate limited to prevent brute-force OTP attacks and share enumeration
app.post("/share/store", shareLimiter, ShareController.storeShare)
app.post("/share/retrieve", shareLimiter, ShareController.retrieveShare)
app.post("/share/update", shareLimiter, ShareController.updateShare)
app.post("/share/delete", shareLimiter, ShareController.deleteUser)

export default app
