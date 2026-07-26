import express, { type ErrorRequestHandler } from 'express'
import request from 'supertest'

import Capability from '../../capability/capability.js'
import { PaymailBadRequestError } from '../../errors/index.js'
import PaymailRouter from '../paymailRouter.js'
import PaymailRoute from '../paymailRoutes/paymailRoute.js'

function createRoute(
  endpoint = '/generic/:paymail',
  domainLogicHandler: ConstructorParameters<
    typeof PaymailRoute
  >[0]['domainLogicHandler'] = params => {
    const { name, domain } = PaymailRoute.getNameAndDomain(params)
    return { name, domain }
  }
): PaymailRoute {
  return new PaymailRoute({
    capability: new Capability({
      code: 'generic',
      title: 'Generic Paymail capability'
    }),
    endpoint,
    domainLogicHandler
  })
}

describe('PaymailRoute', () => {
  it('validates configured endpoints', () => {
    expect(() => createRoute('')).toThrow('Invalid endpoint')
    expect(() => createRoute('relative')).toThrow('Invalid endpoint')
  })

  it('parses Paymail handles and rejects malformed values', () => {
    expect(PaymailRoute.getNameAndDomain({ paymail: 'alice@example.test' })).toEqual({
      name: 'alice',
      domain: 'example.test'
    })
    expect(() => PaymailRoute.getNameAndDomain({ paymail: 'invalid' })).toThrow(
      PaymailBadRequestError
    )
    expect(() =>
      PaymailRoute.getNameAndDomain({ paymail: 'alice@example.test@attacker.test' })
    ).toThrow(PaymailBadRequestError)
    expect(() => PaymailRoute.getNameAndDomain({ paymail: 'alice@bad domain' })).toThrow(
      PaymailBadRequestError
    )
    expect(() => PaymailRoute.getNameAndDomain({ paymail: 'alice/../../@example.test' })).toThrow(
      PaymailBadRequestError
    )
  })

  it('serves the base route contract and serializes its response', async () => {
    const app = express()
    app.use(
      new PaymailRouter({
        baseUrl: 'https://example.test',
        routes: [createRoute()]
      }).getRouter()
    )

    const response = await request(app).get('/generic/alice@example.test')

    expect(response.statusCode).toBe(200)
    expect(response.type).toBe('application/json')
    expect(response.body).toEqual({ name: 'alice', domain: 'example.test' })
  })

  it('uses the default error handler for bad requests and unexpected failures', async () => {
    const app = express()
    app.use(
      new PaymailRouter({
        baseUrl: 'https://example.test',
        routes: [
          createRoute('/missing/:other'),
          createRoute('/error/:paymail', () => {
            throw new Error('route failed')
          })
        ]
      }).getRouter()
    )

    const missing = await request(app).get('/missing/value')
    const failure = await request(app).get('/error/alice@example.test')

    expect(missing.statusCode).toBe(400)
    expect(missing.text).toBe('Paymail handle is required.')
    expect(failure.statusCode).toBe(500)
    expect(failure.text).toBe('Internal server error')
  })

  it('normalizes non-Error body validation failures into bad requests', async () => {
    class InvalidBodyRoute extends PaymailRoute {
      protected override async validateBody(): Promise<unknown> {
        throw 'invalid body'
      }
    }

    const route = new InvalidBodyRoute({
      capability: new Capability({
        code: 'invalid-body',
        title: 'Invalid body test',
        method: 'POST'
      }),
      endpoint: '/invalid-body/:paymail',
      domainLogicHandler: () => ({ accepted: true })
    })
    const app = express()
    app.use(
      new PaymailRouter({
        baseUrl: 'https://example.test',
        routes: [route]
      }).getRouter()
    )

    const response = await request(app).post('/invalid-body/alice@example.test').send({})

    expect(response.statusCode).toBe(400)
    expect(response.text).toBe('invalid body')
  })

  it('rejects unsupported route methods defensively', () => {
    const route = createRoute()
    jest.spyOn(route, 'getMethod').mockReturnValue('PUT' as 'GET')

    expect(
      () =>
        new PaymailRouter({
          baseUrl: 'https://example.test',
          routes: [route]
        })
    ).toThrow('Unsupported method: PUT')
  })

  it('allows applications to handle route errors before the safe fallback', async () => {
    const customErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
      response.status(422).json({
        message: error instanceof Error ? error.message : 'unknown'
      })
    }
    const app = express()
    app.use(
      new PaymailRouter({
        baseUrl: 'https://example.test',
        routes: [
          createRoute('/error/:paymail', () => {
            throw 'non-error failure'
          })
        ],
        errorHandler: customErrorHandler
      }).getRouter()
    )

    const response = await request(app).get('/error/alice@example.test')

    expect(response.statusCode).toBe(422)
    expect(response.body).toEqual({ message: 'unknown' })
  })
})
