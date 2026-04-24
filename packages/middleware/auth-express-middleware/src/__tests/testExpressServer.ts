import express, { Request, Response, NextFunction } from 'express'
import bodyParser from 'body-parser'
import { CompletedProtoWallet, MasterCertificate, PrivateKey, RequestedCertificateSet, SessionManager, VerifiableCertificate } from '@bsv/sdk'
import { MockWallet } from './MockWallet'
import { createAuthMiddleware } from '../index'
import { Server, createServer } from 'http'
// May be necessary when testing depending on your environment:
// import * as crypto from 'crypto'
// global.self = { crypto }

// Create Express app instance
// Export a function to start the server programmatically
export const startServer = (port = 3000): Server => {
  const app = express()

  // Middleware setup
  app.use(bodyParser.json())
  app.use(express.urlencoded({ extended: true }))
  app.use(express.text())
  app.use(bodyParser.raw({ type: 'application/octet-stream', limit: '500mb' }))

  // Mocked certificate and wallet setup
  // Used in the authentication middleware as needed:
  const certificatesToRequest: RequestedCertificateSet = {
    certifiers: ['03caa1baafa05ecbf1a5b310a7a0b00bc1633f56267d9f67b1fd6bb23b3ef1abfa'],
    types: { 'z40BOInXkI8m7f/wBrv4MJ09bZfzZbTj2fJqCtONqCY=': ['firstName'] }
  }

  const privKey = new PrivateKey(1)
  const mockWallet = new MockWallet(privKey);
  const sessionManager = new SessionManager();

  // Asynchronous setup for certificates and middleware
  (async () => {
    const certifierPrivateKey = PrivateKey.fromHex('5a4d867377bd44eba1cecd0806c16f24e293f7e218c162b1177571edaeeaecef')
    const certifierWallet = new CompletedProtoWallet(certifierPrivateKey)
    const certificateType = 'z40BOInXkI8m7f/wBrv4MJ09bZfzZbTj2fJqCtONqCY='
    const fields = { firstName: 'Alice', lastName: 'Doe' }

    const masterCert = await MasterCertificate.issueCertificateForSubject(
      certifierWallet,
      (await mockWallet.getPublicKey({ identityKey: true })).publicKey,
      fields,
      certificateType
    )
    mockWallet.addMasterCertificate(masterCert)
  })().catch(e => console.error(e))

  // This allows the API to be used everywhere when CORS is enforced
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', '*')
    res.header('Access-Control-Allow-Methods', '*')
    res.header('Access-Control-Expose-Headers', '*')
    res.header('Access-Control-Allow-Private-Network', 'true')

    if (req.method === 'OPTIONS') {
      // Handle CORS preflight requests to allow cross-origin POST/PUT requests
      res.sendStatus(200)
    } else {
      next()
    }
  })

  // Define routes
  app.post('/no-auth', (req: Request, res: Response) => {
    res.status(200).send({ message: 'Non auth endpoint!' })
  })

  // Test-only route to emulate "different instance" behavior by dropping in-memory auth sessions.
  app.post('/__clear-auth-sessions', (_req: Request, res: Response) => {
    const manager = sessionManager as any
    const sessionNonceToSession: Map<string, unknown> | undefined = manager.sessionNonceToSession
    const identityKeyToNonces: Map<string, unknown> | undefined = manager.identityKeyToNonces

    const beforeSessionCount = sessionNonceToSession?.size ?? 0
    const beforeIdentityCount = identityKeyToNonces?.size ?? 0

    sessionNonceToSession?.clear()
    identityKeyToNonces?.clear()

    res.status(200).json({
      ok: true,
      beforeSessionCount,
      beforeIdentityCount
    })
  })

  const authMiddleware = createAuthMiddleware({
    allowUnauthenticated: false,
    wallet: mockWallet,
    sessionManager,
    onCertificatesReceived: (_senderPublicKey: string, certs: VerifiableCertificate[], req: Request, res: Response, next: NextFunction) => {
      console.log('Certificates received:', certs)
    },
    // certificatesToRequest
  })

  // Add the mutual authentication middleware
  app.use(authMiddleware)

  app.get('/', (req: Request, res: Response) => {
    res.send('Hello, world!')
  })

  app.get('/other-endpoint', (req: Request, res: Response) => {
    res.send('This is another endpoint.')
  })

  app.post('/error-500', (req: Request, res: Response) => {
    res.status(500).json({
      status: 'error',
      code: 'ERR_BAD_THING',
      description: 'A bad thing has happened.'
    })
  })

  app.post('/other-endpoint', (req: Request, res: Response) => {
    res.status(200).send({ message: 'This is another endpoint. 😅' })
  })

  app.post('/cert-protected-endpoint',  (req: Request, res: Response) => {
  console.log('Received POST body:', req.body)
   res.status(200).send({ message: 'You must have certs!' })
    // await (res as any).sendCertificateRequest(certsToRequest, identityKey)
  })

  app.post('/payment-protected', (req: Request, res: Response) => {
    res.json({ message: 'You must have paid!' })
  })

  app.put('/put-endpoint', (req: Request, res: Response) => {
    console.log('Received PUT body:', req.body)
    res.send({ status: 'updated', body: req.body })
  })

  app.delete('/delete-endpoint', (req: Request, res: Response) => {
    console.log('Received DELETE request')
    res.send({ status: 'deleted' })
  })

  app.post('/large-upload', (req: Request, res: Response) => {
    console.log('Received binary upload, size:', req.body.length)
    res.send({ status: 'upload received', size: req.body.length })
  })

  app.get('/query-endpoint', (req: Request, res: Response) => {
    console.log('Received query parameters:', req.query)
    res.send({ status: 'query received', query: req.query })
  })

  app.get('/custom-headers', (req: Request, res: Response) => {
    console.log('Received headers:', req.headers)
    res.send({ status: 'headers received', headers: req.headers })
  })

  // Fallback for 404 errors
  app.use((req, res, next) => {
    res.status(404).json({
      status: 'error',
      code: 'NOT_FOUND',
      message: 'The requested resource was not found on this server.'
    })
  })

  return createServer(app) // Return un-listened server
}
// For testing independently of integration tests:
// const server = startServer(3000);
// server.listen(3000, () => console.log('Server is running on http://localhost:3000'))
