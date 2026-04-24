import express from "express"
import bodyParser from "body-parser"
import rateLimit from "express-rate-limit"
import { InfoController } from "./controllers/InfoController"
import { AuthController } from "./controllers/AuthController"
import { UserController } from "./controllers/UserController"
import { FaucetController } from "./controllers/FaucetController"
import { AccountDeletionController } from "./controllers/AccountDeletionController"
import { ShareController } from "./controllers/ShareController"

const app = express()

// Alternatively, you could add custom middleware to set headers and handle OPTIONS:
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', '*')
  res.header('Access-Control-Allow-Methods', '*')
  res.header('Access-Control-Expose-Headers', '*')
  res.header('Access-Control-Allow-Private-Network', 'true')
  if (req.method === 'OPTIONS') {
    res.sendStatus(200)
  } else {
    next()
  }
})

app.use(bodyParser.json())

// Rate limiting for account deletion endpoints to prevent abuse
// Protects against SMS spam (start) and brute-force OTP attacks (complete)
const accountDeletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minute window
  max: 5, // Limit each IP to 5 requests per window
  message: "Too many account deletion attempts from this IP, please try again after 15 minutes",
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
})

// Info route
app.get("/info", InfoController.getInfo)

// Auth routes
app.post("/auth/start", AuthController.startAuth)
app.post("/auth/complete", AuthController.completeAuth)

// Account deletion routes (for users who can't access their account)
// Rate limited to prevent SMS spam and brute-force attacks
app.post("/account/delete/start", accountDeletionLimiter, AccountDeletionController.startDeletion)
app.post("/account/delete/complete", accountDeletionLimiter, AccountDeletionController.completeDeletion)

// User routes
app.post("/user/linkedMethods", UserController.listLinkedMethods)
app.post("/user/unlinkMethod", UserController.unlinkMethod)
app.post("/user/delete", UserController.deleteUser)

// Faucet route
app.post("/faucet/request", FaucetController.requestFaucet)

// Shamir share routes (for 2-of-3 key recovery system)
// Rate limited to prevent brute-force OTP attacks and share enumeration
const shareLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minute window
    max: 10, // Limit each IP to 10 requests per window
    message: "Too many share requests from this IP, please try again after 15 minutes",
    standardHeaders: true,
    legacyHeaders: false,
})
app.post("/share/store", shareLimiter, ShareController.storeShare)
app.post("/share/retrieve", shareLimiter, ShareController.retrieveShare)
app.post("/share/update", shareLimiter, ShareController.updateShare)
app.post("/share/delete", shareLimiter, ShareController.deleteUser)

export default app
