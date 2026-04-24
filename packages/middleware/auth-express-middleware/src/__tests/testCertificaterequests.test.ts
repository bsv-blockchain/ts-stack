import {
  CompletedProtoWallet,
  PrivateKey,
  RequestedCertificateTypeIDAndFieldList,
  AuthFetch,
  MasterCertificate,
} from '@bsv/sdk'
import { Server } from 'http'
import { startCertServer } from './testCertExpressServer'
import { MockWallet } from './MockWallet'

export interface RequestedCertificateSet {
  certifiers: string[]
  types: RequestedCertificateTypeIDAndFieldList
}

describe('AuthFetch and AuthExpress Certificates Tests', () => {
  const privKey = PrivateKey.fromRandom()
  let server: Server & { ready: Promise<void> }
  let sockets: any[] = []

  beforeAll(async () => {
    // Start the Express server
    server = startCertServer(3001)
    server.on('connection', (socket) => {
      sockets.push(socket)
      socket.on('close', () => {
        sockets = sockets.filter(s => s !== socket)
      })
    })
    await new Promise<void>((resolve, reject) => {
      if (server.listening) {
        console.log('Test server is running on http://localhost:3001')
        resolve()
      } else {
        server.once('listening', () => {
          console.log('Test server is running on http://localhost:3001')
          resolve()
        })
        server.once('error', reject)
      }
    })
    // Wait for async certificate seeding to finish before tests run
    await server.ready
  })

  afterAll(async () => {
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections()
    } else {
      sockets.forEach(s => { if (!s.destroyed) s.destroy() })
    }
    sockets = []

    if (!server.listening) return

    await new Promise<void>((resolve, reject) => {
      server.once('close', () => resolve())
      server.once('error', reject)
      server.close()
    })
  })


  test('Test 12: Certificate request', async () => {
    const requestedCertificates: RequestedCertificateSet = {
      certifiers: [
        '03caa1baafa05ecbf1a5b310a7a0b00bc1633f56267d9f67b1fd6bb23b3ef1abfa',
      ],
      types: {
        'z40BOInXkI8m7f/wBrv4MJ09bZfzZbTj2fJqCtONqCY=': ['firstName'],
      }
    }
    const walletWithRequests = new MockWallet(privKey)
    const authWithCerts = new AuthFetch(walletWithRequests)
    const certRequests = [
      authWithCerts.sendCertificateRequest(
        'http://localhost:3001',
        requestedCertificates
      )
    ]
    const certs = await Promise.all(certRequests)
    expect(certs).toBeDefined()
    expect(certs.length).toBe(1)
    // Add further assertions based on expected certificates
  }, 30000)


  test('Test 16: Simple POST on /cert-protected-endpoint', async () => {
    const walletWithCerts = new MockWallet(privKey)

    const certifierPrivateKey = PrivateKey.fromHex('5a4d867377bd44eba1cecd0806c16f24e293f7e218c162b1177571edaeeaecef')
    const certifierWallet = new CompletedProtoWallet(certifierPrivateKey)
    const certificateType = 'z40BOInXkI8m7f/wBrv4MJ09bZfzZbTj2fJqCtONqCY='
    const fields = { firstName: 'Alice', lastName: 'Doe' }

    const masterCert = await MasterCertificate.issueCertificateForSubject(
      certifierWallet,
      (await walletWithCerts.getPublicKey({ identityKey: true })).publicKey,
      fields,
      certificateType
    )
    walletWithCerts.addMasterCertificate(masterCert)
    const authFetch = new AuthFetch(walletWithCerts)
    let res
    try {
      res = await authFetch.fetch(
        'http://localhost:3001/cert-protected-endpoint', {
        method: 'POST', headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ message: 'Hello protected Route!' })
      })
    } catch (error) {
      console.error('Error during fetch:', error)
    }
    expect(res!.status).toBe(200)
    const body = await res!.text()
    expect(body).toBeDefined()
    console.log(body)

  }, 300000)
})