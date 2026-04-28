import request from 'supertest'
import express from 'express'
import PaymailRouter from '../../../dist/cjs/src/paymailRouter/paymailRouter.js'
import PublicProfileRoute from '../../../dist/cjs/src/paymailRouter/paymailRoutes/publicProfileRoute.js'

describe('#Paymail Server - Capability discovery', () => {
  let app

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost:3000'

    const routes = [
      new PublicProfileRoute({
        domainLogicHandler: (params) => {
          const { name, domain } = PublicProfileRoute.getNameAndDomain(params)
          return {
            name,
            domain,
            avatar: `https://avatar.com/${name}@${domain}`
          }
        }
      })
    ]

    const paymailRouter = new PaymailRouter({
      basePath: '/paymail',
      baseUrl,
      routes,
      requestSenderValidation: true
    })
    app.use(paymailRouter.getRouter())
  })

  it('should get capabilities', async () => {
    const response = await request(app).get('/.well-known/bsvalias')
    expect(response.statusCode).toBe(200)
    expect(response.body.bsvalias).toBe('1.0')
    expect(response.body.capabilities.f12f968c92d6).toEqual('http://localhost:3000/paymail/public-profile/{alias}@{domain.tld}')
    expect(response.body.capabilities['6745385c3fc0']).toEqual(true)
  })
})
