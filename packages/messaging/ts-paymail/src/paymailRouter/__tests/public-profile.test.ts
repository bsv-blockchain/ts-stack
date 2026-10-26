import request from 'supertest'
import express, { type Express } from 'express'
import PaymailRouter from '../paymailRouter.js'
import PublicProfileRoute from '../paymailRoutes/publicProfileRoute.js'

describe('#Paymail Server - Get Public Profile', () => {
  let app: Express

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost:3000'

    const routes = [
      new PublicProfileRoute({
        domainLogicHandler: params => {
          const { name, domain } = PublicProfileRoute.getNameAndDomain(params)
          return {
            name,
            domain,
            avatar: `https://avatar.com/${name}@${domain}`
          }
        }
      })
    ]

    const paymailRouter = new PaymailRouter({ baseUrl, routes })
    app.use(paymailRouter.getRouter())
  })

  it('should get public profile for user paymail', async () => {
    const response = await request(app).get('/public-profile/satoshi@bsv.org')
    expect(response.statusCode).toBe(200)
    expect(response.body.avatar).toEqual('https://avatar.com/satoshi@bsv.org')
    expect(response.body.name).toEqual('satoshi')
  })

  it.each([
    null,
    42,
    'not-a-url',
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'http://avatar.example/alice.png',
    'https://user:secret@avatar.example/alice.png',
    'https://avatar.example/alice.png#active-fragment',
    'https://127.0.0.1/alice.png',
    'https://[::1]/alice.png',
    'https://localhost/alice.png',
    'https://localhost./alice.png',
    'https://service.localhost./alice.png'
  ])('rejects an unsafe avatar returned by the domain handler: %s', async avatar => {
    const unsafeApp = express()
    const route = new PublicProfileRoute({
      domainLogicHandler: () => ({ name: 'Alice', avatar })
    })
    unsafeApp.use(
      new PaymailRouter({ baseUrl: 'http://localhost:3000', routes: [route] }).getRouter()
    )

    const response = await request(unsafeApp).get('/public-profile/alice@example.test')
    expect(response.statusCode).toBe(500)
  })

  it.each([null, '', 42])(
    'rejects an invalid profile name returned by the domain handler: %s',
    async name => {
      const invalidApp = express()
      const route = new PublicProfileRoute({
        domainLogicHandler: () => ({ name, avatar: 'https://avatar.example/alice.png' })
      })
      invalidApp.use(
        new PaymailRouter({ baseUrl: 'http://localhost:3000', routes: [route] }).getRouter()
      )

      const response = await request(invalidApp).get('/public-profile/alice@example.test')
      expect(response.statusCode).toBe(500)
    }
  )
})
