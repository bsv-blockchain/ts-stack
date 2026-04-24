import express, { Router, ErrorRequestHandler } from 'express'
import bodyParser from 'body-parser'
import PaymailRoute from './paymailRoutes/paymailRoute.js'
import RequestSenderValidationCapability from '../capability/requestSenderValidationCapability.js'
import { PaymailBadRequestError } from '../errors/index.js'

interface PaymailRouterConfig {
  baseUrl: string
  basePath?: string
  routes: PaymailRoute[]
  errorHandler?: ErrorRequestHandler
  requestSenderValidation?: boolean
}

/**
 * PaymailRouter is responsible for routing and handling Paymail requests.
 * It sets up the necessary routes and handlers based on the given configuration.
 */
export default class PaymailRouter {
  private readonly router: Router
  public baseUrl: string
  public basePath: string
  public routes: PaymailRoute[]
  public requestSenderValidation: boolean

  /**
   * Creates an instance of PaymailRouter.
   * @param config - Configuration options for the PaymailRouter.
   */
  constructor (config: PaymailRouterConfig) {
    this.baseUrl = config.baseUrl
    this.basePath = config.basePath ?? ''
    this.router = express.Router()
    this.router.use(bodyParser.json({ type: 'application/json' }))
    this.routes = config.routes
    this.requestSenderValidation = config.requestSenderValidation ?? false

    this.routes.forEach(route => {
      const method = route.getMethod()
      const path = this.getBasePath() + route.getEndpoint()
      if (method === 'GET') {
        this.router.get(path, route.getHandler())
      } else if (method === 'POST') {
        this.router.post(path, route.getHandler())
      } else {
        throw new PaymailBadRequestError('Unsupported method: ' + method)
      }
    })

    this.addWellKnownRouter()

    if (config.errorHandler) {
      this.router.use(config.errorHandler)
    }

    this.router.use(this.defaultErrorHandler())
  }

  /**
   * Default error handler for the PaymailRouter.
   * @returns An express middleware for handling errors.
   */
  private readonly defaultErrorHandler = () => {
    return (err, req, res, next) => {
      if (err instanceof PaymailBadRequestError) {
        return res.status(400).send(err.message)
      }
      res.status(500).send(err.message)
    }
  }

  /**
   * Adds a route for handling the well-known BSV alias protocol.
   */
  private addWellKnownRouter (): void {
    this.router.get('/.well-known/bsvalias', (req, res) => {
      const capabilities = this.routes.reduce((map, route) => {
        const endpoint = route.getEndpoint().replace(/:paymail/g, '{alias}@{domain.tld}').replace(/:pubkey/g, '{pubkey}')
        map[route.getCode()] = this.joinUrl(this.baseUrl, this.getBasePath(), endpoint)
        return map
      }, {})
      capabilities[RequestSenderValidationCapability.getCode()] = !!this.requestSenderValidation
      res.type('application/json')
      res.send({
        bsvalias: '1.0',
        capabilities
      })
    })
  }

  private joinUrl (...parts: string[]): string {
    return parts.map(part => part.replace(/(^\/+|\/+$)/g, '')).join('/')
  }

  private getBasePath (): string {
    return this.basePath
  }

  /**
   * Gets the configured express Router.
   * @returns The express Router with all configured routes and handlers.
   */
  public getRouter (): Router {
    return this.router
  }
}
