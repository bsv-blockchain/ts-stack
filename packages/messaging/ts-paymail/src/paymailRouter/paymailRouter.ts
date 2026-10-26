import express from 'express'
import type { ErrorRequestHandler, NextFunction, Request, Response, Router } from 'express'
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

interface RegisteredPaymailRoute {
  code: string
  endpoint: string
  handler: ReturnType<PaymailRoute['getHandler']>
  method: ReturnType<PaymailRoute['getMethod']>
  senderValidationMode: ReturnType<PaymailRoute['getSenderValidationMode']>
}

/**
 * PaymailRouter is responsible for routing and handling Paymail requests.
 * It sets up the necessary routes and handlers based on the given configuration.
 */
export default class PaymailRouter {
  private readonly router: Router
  private readonly registeredRoutes: readonly RegisteredPaymailRoute[]
  private readonly advertisedBaseUrl: string
  private readonly registeredBasePath: string
  private readonly advertisedRequestSenderValidation: boolean
  public baseUrl: string
  public basePath: string
  public routes: PaymailRoute[]
  public requestSenderValidation: boolean

  /**
   * Creates an instance of PaymailRouter.
   * @param config - Configuration options for the PaymailRouter.
   */
  constructor(config: PaymailRouterConfig) {
    const configuredBaseUrl = config.baseUrl
    const configuredBasePath = config.basePath
    const configuredRoutes = config.routes
    const configuredErrorHandler = config.errorHandler
    const configuredSenderValidation = config.requestSenderValidation
    if (!Array.isArray(configuredRoutes) || configuredRoutes.length > 255) {
      throw new TypeError('routes must be an array containing at most 255 Paymail routes')
    }
    if (configuredErrorHandler !== undefined && typeof configuredErrorHandler !== 'function') {
      throw new TypeError('errorHandler must be a function')
    }
    if (
      configuredSenderValidation !== undefined &&
      typeof configuredSenderValidation !== 'boolean'
    ) {
      throw new TypeError('requestSenderValidation must be a boolean')
    }
    this.advertisedBaseUrl = this.validateBaseUrl(configuredBaseUrl)
    this.registeredBasePath = this.validateBasePath(configuredBasePath ?? '')
    // These public fields remain for backwards compatibility. The mounted
    // router and its authority document intentionally use the immutable
    // validated snapshots above so later mutation cannot rewrite discovery.
    this.baseUrl = this.advertisedBaseUrl
    this.basePath = this.registeredBasePath
    this.router = express.Router()
    this.router.use(express.json({ type: 'application/json' }))
    this.registeredRoutes = Object.freeze(configuredRoutes.map(route => this.snapshotRoute(route)))
    this.routes = [...configuredRoutes]
    this.validateUniqueRoutes(this.registeredRoutes)
    const senderValidationModes = this.registeredRoutes
      .map(route => route.senderValidationMode)
      .filter(mode => mode !== 'not-applicable')
    // Per-route verification remains authoritative. Preserve mixed legacy
    // configurations, but advertise the global capability only when every
    // transaction receive route actually enforces it.
    const derivedSenderValidation =
      senderValidationModes.length > 0 && senderValidationModes.every(mode => mode === 'required')
    if (
      senderValidationModes.length > 0 &&
      configuredSenderValidation != null &&
      configuredSenderValidation !== derivedSenderValidation
    ) {
      throw new Error(
        'requestSenderValidation must match the configured transaction receive routes'
      )
    }
    this.advertisedRequestSenderValidation = configuredSenderValidation ?? derivedSenderValidation
    this.requestSenderValidation = this.advertisedRequestSenderValidation

    this.registeredRoutes.forEach(route => {
      const { method } = route
      const path = this.getBasePath() + route.endpoint
      if (method === 'GET') {
        this.router.get(path, route.handler)
      } else if (method === 'POST') {
        this.router.post(path, route.handler)
      } else {
        throw new PaymailBadRequestError('Unsupported method: ' + method)
      }
    })

    this.addWellKnownRouter()

    if (configuredErrorHandler) {
      this.router.use(configuredErrorHandler)
    }

    this.router.use(this.defaultErrorHandler())
  }

  /**
   * Default error handler for the PaymailRouter.
   * @returns An express middleware for handling errors.
   */
  private readonly defaultErrorHandler = (): ErrorRequestHandler => {
    return (err: unknown, _request: Request, res: Response, _next: NextFunction) => {
      if (err instanceof PaymailBadRequestError) {
        res.status(400).send(err.message)
        return
      }
      const parserError = err as { status?: unknown; type?: unknown }
      if (parserError.status === 400 && parserError.type === 'entity.parse.failed') {
        res.status(400).send('Invalid JSON body')
        return
      }
      res.status(500).send('Internal server error')
    }
  }

  /**
   * Adds a route for handling the well-known BSV alias protocol.
   */
  private addWellKnownRouter(): void {
    this.router.get('/.well-known/bsvalias', (_request, res) => {
      const capabilities = this.registeredRoutes.reduce<Record<string, string | boolean>>(
        (map, route) => {
          const endpoint = route.endpoint
            .replaceAll(':paymail', '{alias}@{domain.tld}')
            .replaceAll(':pubkey', '{pubkey}')
          map[route.code] = this.joinUrl(this.advertisedBaseUrl, this.getBasePath(), endpoint)
          return map
        },
        Object.create(null) as Record<string, string | boolean>
      )
      capabilities[RequestSenderValidationCapability.getCode()] =
        this.advertisedRequestSenderValidation
      res.type('application/json')
      res.send({
        bsvalias: '1.0',
        capabilities
      })
    })
  }

  private joinUrl(...parts: string[]): string {
    return parts
      .map(part => this.trimSlashes(part))
      .filter(part => part.length > 0)
      .join('/')
  }

  private validateBaseUrl(value: string): string {
    if (typeof value !== 'string') throw new Error('Invalid Paymail baseUrl')
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('Invalid Paymail baseUrl')
    }
    const localDevelopment = url.hostname === 'localhost'
    if (
      (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      throw new Error('Invalid Paymail baseUrl')
    }
    return value.replace(/\/$/, '')
  }

  private validateBasePath(value: string): string {
    if (
      typeof value !== 'string' ||
      (value !== '' &&
        (!value.startsWith('/') ||
          value.includes('?') ||
          value.includes('#') ||
          value.includes('..')))
    ) {
      throw new Error('Invalid Paymail basePath')
    }
    return value.replace(/\/$/, '')
  }

  private validateUniqueRoutes(routes: readonly RegisteredPaymailRoute[]): void {
    const paths = new Set<string>()
    const codes = new Set<string>([RequestSenderValidationCapability.getCode()])
    for (const route of routes) {
      const path = `${route.method} ${this.getBasePath()}${route.endpoint}`
      if (paths.has(path)) throw new Error(`Duplicate Paymail route: ${path}`)
      paths.add(path)
      if (codes.has(route.code)) throw new Error(`Duplicate Paymail capability: ${route.code}`)
      codes.add(route.code)
    }
  }

  private snapshotRoute(route: PaymailRoute): RegisteredPaymailRoute {
    if (route == null || typeof route !== 'object') {
      throw new TypeError('routes must contain Paymail route objects')
    }
    const code = route.getCode()
    const endpoint = route.getEndpoint()
    const handler = route.getHandler()
    const method = route.getMethod()
    const senderValidationMode = route.getSenderValidationMode()
    if (
      typeof code !== 'string' ||
      code.length === 0 ||
      code.length > 256 ||
      this.hasControlCharacter(code) ||
      code === '__proto__' ||
      code === 'constructor' ||
      code === 'prototype'
    ) {
      throw new TypeError('Invalid Paymail capability code')
    }
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
      throw new TypeError('Invalid Paymail route endpoint')
    }
    if (typeof handler !== 'function') throw new TypeError('Invalid Paymail route handler')
    if (method !== 'GET' && method !== 'POST') {
      throw new PaymailBadRequestError('Unsupported method: ' + String(method))
    }
    if (
      senderValidationMode !== 'not-applicable' &&
      senderValidationMode !== 'required' &&
      senderValidationMode !== 'disabled'
    ) {
      throw new TypeError('Invalid Paymail sender-validation mode')
    }
    return Object.freeze({ code, endpoint, handler, method, senderValidationMode })
  }

  private trimSlashes(part: string): string {
    let start = 0
    let end = part.length
    while (start < end && part[start] === '/') start += 1
    while (end > start && part[end - 1] === '/') end -= 1
    return part.slice(start, end)
  }

  private hasControlCharacter(value: string): boolean {
    for (const character of value) {
      const codePoint = character.codePointAt(0)
      if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
    }
    return false
  }

  private getBasePath(): string {
    return this.registeredBasePath
  }

  /**
   * Gets the configured express Router.
   * @returns The express Router with all configured routes and handlers.
   */
  public getRouter(): Router {
    return this.router
  }
}
