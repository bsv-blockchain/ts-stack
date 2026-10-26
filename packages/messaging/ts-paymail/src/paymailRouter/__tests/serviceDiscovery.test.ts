import request from 'supertest'
import express, { type Express } from 'express'
import PaymailRouter from '../paymailRouter.js'
import PublicProfileRoute from '../paymailRoutes/publicProfileRoute.js'

describe('#Paymail Server - Capability discovery', () => {
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
    expect(response.body.capabilities.f12f968c92d6).toEqual(
      'http://localhost:3000/paymail/public-profile/{alias}@{domain.tld}'
    )
    expect(response.body.capabilities['6745385c3fc0']).toEqual(true)
  })

  it('keeps mounted routes and discovery bound to construction-time configuration', async () => {
    const mutableRoute = new PublicProfileRoute({
      domainLogicHandler: () => ({
        name: 'Alice',
        avatar: 'https://avatar.example/alice.png'
      })
    })
    const router = new PaymailRouter({
      basePath: '/original',
      baseUrl: 'https://paymail.example',
      routes: [mutableRoute],
      requestSenderValidation: false
    })
    router.basePath = '/rewritten'
    router.baseUrl = 'https://attacker.example'
    router.requestSenderValidation = true
    router.routes.length = 0
    jest.spyOn(mutableRoute, 'getCode').mockReturnValue('__proto__')
    jest.spyOn(mutableRoute, 'getEndpoint').mockReturnValue('/rewritten/:paymail')

    const isolatedApp = express()
    isolatedApp.use(router.getRouter())
    const discovery = await request(isolatedApp).get('/.well-known/bsvalias')
    const mounted = await request(isolatedApp).get('/original/public-profile/alice@example.test')

    expect(discovery.statusCode).toBe(200)
    expect(discovery.body.capabilities.f12f968c92d6).toBe(
      'https://paymail.example/original/public-profile/{alias}@{domain.tld}'
    )
    expect(discovery.body.capabilities['6745385c3fc0']).toBe(false)
    expect(Object.hasOwn(discovery.body.capabilities, '__proto__')).toBe(false)
    expect(mounted.statusCode).toBe(200)
  })

  it('rejects duplicate capability codes that would make discovery ambiguous', () => {
    const first = new PublicProfileRoute({ domainLogicHandler: () => ({}) })
    const second = new PublicProfileRoute({ domainLogicHandler: () => ({}) })
    jest.spyOn(second, 'getEndpoint').mockReturnValue('/secondary-profile/:paymail')

    expect(
      () =>
        new PaymailRouter({
          baseUrl: 'https://paymail.example',
          routes: [first, second]
        })
    ).toThrow('Duplicate Paymail capability: f12f968c92d6')
  })
})
