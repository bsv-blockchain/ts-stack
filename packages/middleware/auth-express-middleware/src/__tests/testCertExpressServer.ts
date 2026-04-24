import express, { Request, Response, NextFunction } from 'express'
import bodyParser from 'body-parser'
import { CompletedProtoWallet, MasterCertificate, PrivateKey, RequestedCertificateSet, VerifiableCertificate } from '@bsv/sdk'
import { MockWallet } from './MockWallet'
import { createAuthMiddleware } from '../index'
// May be necessary when testing depending on your environment:
// import * as crypto from 'crypto'
// global.self = { crypto }

// Create Express app instance
// Export a function to start the server programmatically
export const startCertServer = (port = 3001): ReturnType<typeof app.listen> & { ready: Promise<void> } => {
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

  const privKey = new PrivateKey(2)
  const mockWallet = new MockWallet(privKey);

  // Asynchronous setup for certificates — exposed as server.ready
  const ready = (async () => {
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
  })()

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

  let certsreceived: VerifiableCertificate[]

  const authMiddleware = createAuthMiddleware({
    allowUnauthenticated: false,
    wallet: mockWallet,
    onCertificatesReceived: async (_senderPublicKey: string, certs: VerifiableCertificate[], req: Request, res: Response, next: NextFunction) => {
      certsreceived = certs
      console.log('Certificates received:', certs)
    },
    certificatesToRequest
  })

  // Add the mutual authentication middleware
  app.use(authMiddleware)

  app.get('/', (req: Request, res: Response) => {
    res.send('Hello, world!')
  })

  app.post('/cert-protected-endpoint', async (req: Request, res: Response) => {
    console.log('Received POST body:', req.body)
    //wait a moment for the certificates to be received
    await new Promise(resolve => {
      const t = setTimeout(resolve, 5000)
      if (typeof t.unref === 'function') t.unref()
    })
    if (certsreceived) {
      console.log('Certificates received in POST:', certsreceived)
      res.status(200).send({ message: 'You have certs!' })
    } else {
      res.status(401).send({ message: 'You must have certs!' })
    }
  })

  // Fallback for 404 errors
  app.use((req, res, next) => {
    res.status(404).json({
      status: 'error',
      code: 'NOT_FOUND',
      message: 'The requested resource was not found on this server.'
    })
  })

  const server = app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`)
  }) as ReturnType<typeof app.listen> & { ready: Promise<void> }
  server.ready = ready
  return server
}
// For testing independently of integration tests:
// startServer()