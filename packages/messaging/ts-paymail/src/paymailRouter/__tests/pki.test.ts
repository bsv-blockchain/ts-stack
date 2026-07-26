import request from 'supertest'
import express, { type Express } from 'express'
import PaymailRouter from '../paymailRouter.js'
import PublicKeyInfrastructureRoute from '../paymailRoutes/pki.js'
import VerifyPublicKeyOwnerRoute from '../paymailRoutes/verifyPublicKeyOwner.js'
import { PrivateKey } from '@bsv/sdk'

describe('#Paymail Server - PKI', () => {
  let app: Express
  const userIdentityKey = PrivateKey.fromRandom()

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost:3000'

    const routes = [
      new PublicKeyInfrastructureRoute({
        domainLogicHandler: params => {
          const { name, domain } = PublicKeyInfrastructureRoute.getNameAndDomain(params)
          return {
            handle: `${name}@${domain}`,
            pubkey: userIdentityKey.toPublicKey().toString()
          }
        }
      }),
      new VerifyPublicKeyOwnerRoute({
        domainLogicHandler: params => {
          const { name, domain } = VerifyPublicKeyOwnerRoute.getNameAndDomain(params)
          return {
            handle: `${name}@${domain}`,
            pubkey: params.pubkey,
            match: params.pubkey === userIdentityKey.toPublicKey().toString()
          }
        }
      })
    ]

    const paymailRouter = new PaymailRouter({ baseUrl, routes })
    app.use(paymailRouter.getRouter())
  })

  it('should get identity key for user', async () => {
    const response = await request(app).get('/id/satoshi@bsv.org').send()
    expect(response.statusCode).toBe(200)
    expect(response.body.handle).toEqual('satoshi@bsv.org')
    expect(response.body.pubkey).toEqual(userIdentityKey.toPublicKey().toString())
  })

  it('should verify whether a public key belongs to the Paymail user', async () => {
    const publicKey = userIdentityKey.toPublicKey().toString()
    const response = await request(app).get(`/verifypubkey/satoshi@bsv.org/${publicKey}`)

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      bsvalias: '1.0',
      handle: 'satoshi@bsv.org',
      pubkey: publicKey,
      match: true
    })
  })
})
