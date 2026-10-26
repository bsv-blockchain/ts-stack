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
  },
  code = 'generic'
): PaymailRoute {
  return new PaymailRoute({
    capability: new Capability({
      code,
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

  it('rejects malformed route handles before application logic', async () => {
    const handler = jest.fn(() => ({ accepted: true }))
    const app = express()
    app.use(
      new PaymailRouter({
        baseUrl: 'https://example.test',
        routes: [createRoute('/generic/:paymail', handler)]
      }).getRouter()
    )

    const response = await request(app).get('/generic/not-a-paymail')

    expect(response.statusCode).toBe(400)
    expect(response.text).toBe('Invalid Paymail handle.')
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects unsafe router configuration and malformed JSON', async () => {
    expect(
      () =>
        new PaymailRouter({
          baseUrl: 'https://example.test',
          routes: [createRoute()],
          requestSenderValidation: 0 as unknown as boolean
        })
    ).toThrow('requestSenderValidation must be a boolean')
    expect(
      () => new PaymailRouter({ baseUrl: 'http://internal.example', routes: [createRoute()] })
    ).toThrow('Invalid Paymail baseUrl')
    expect(
      () =>
        new PaymailRouter({
          baseUrl: 'https://example.test/path',
          routes: [createRoute()]
        })
    ).toThrow('Invalid Paymail baseUrl')

    class PostRoute extends PaymailRoute {}
    const postApp = express()
    postApp.use(
      new PaymailRouter({
        baseUrl: 'https://example.test',
        routes: [
          new PostRoute({
            capability: new Capability({ code: 'post', title: 'Post', method: 'POST' }),
            endpoint: '/post/:paymail',
            domainLogicHandler: () => ({})
          })
        ]
      }).getRouter()
    )
    const malformed = await request(postApp)
      .post('/post/alice@example.test')
      .set('Content-Type', 'application/json')
      .send('{')
    expect(malformed.statusCode).toBe(400)
    expect(malformed.text).toBe('Invalid JSON body')
  })

  it('snapshots router configuration accessors exactly once', () => {
    const route = createRoute()
    const reads = {
      baseUrl: 0,
      basePath: 0,
      routes: 0,
      errorHandler: 0,
      requestSenderValidation: 0
    }
    const config = Object.defineProperties(
      {},
      {
        baseUrl: {
          enumerable: true,
          get: () => {
            reads.baseUrl += 1
            return 'https://example.test'
          }
        },
        basePath: {
          enumerable: true,
          get: () => {
            reads.basePath += 1
            return '/paymail'
          }
        },
        routes: {
          enumerable: true,
          get: () => {
            reads.routes += 1
            return [route]
          }
        },
        errorHandler: {
          enumerable: true,
          get: () => {
            reads.errorHandler += 1
            return undefined
          }
        },
        requestSenderValidation: {
          enumerable: true,
          get: () => {
            reads.requestSenderValidation += 1
            return false
          }
        }
      }
    ) as ConstructorParameters<typeof PaymailRouter>[0]

    new PaymailRouter(config)

    expect(reads).toEqual({
      baseUrl: 1,
      basePath: 1,
      routes: 1,
      errorHandler: 1,
      requestSenderValidation: 1
    })
  })

  it('uses the default error handler for bad requests and unexpected failures', async () => {
    const app = express()
    app.use(
      new PaymailRouter({
        baseUrl: 'https://example.test',
        routes: [
          createRoute('/missing/:other'),
          createRoute(
            '/error/:paymail',
            () => {
              throw new Error('route failed')
            },
            'generic-error'
          )
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
