import { Request, Response, RequestHandler, NextFunction } from 'express'
import Capability from '../../capability/capability.js'
import { PaymailBadRequestError } from '../../errors/index.js'

interface PaymailRouteConfig {
  capability: Capability
  endpoint: string
  domainLogicHandler: RequestHandler
}

export type DomainLogicHandler = (params: any, body?: any, pubkey?: string) => Promise<any>

export default class PaymailRoute {
  private readonly capability: Capability
  private readonly endpoint: string
  protected readonly domainLogicHandler: DomainLogicHandler

  constructor (config: PaymailRouteConfig) {
    this.capability = config.capability
    this.endpoint = this.validateEndpoint(config.endpoint)
    this.domainLogicHandler = config.domainLogicHandler
  }

  private validateEndpoint (endpoint: string): string {
    if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
      throw new Error('Invalid endpoint: Endpoint must be a non-empty string starting with "/".')
    }
    return endpoint
  }

  protected async defaultHandler (req: Request, res: Response, next: NextFunction): Promise<any> {
    try {
      await this.validateBody(req.body).catch((error) => {
        throw new PaymailBadRequestError(error.message)
      })
      if (!req.params.paymail) {
        throw new PaymailBadRequestError('Paymail handle is required.')
      }
      const response = await this.domainLogicHandler(req.params, req.body)
      const serializedResponse = this.serializeResponse(response)
      return this.sendSuccessResponse(res, serializedResponse)
    } catch (error) {
      next(error)
    }
  }

  protected async validateBody (body: any): Promise<void> {
    // This method does nothing by default. Child classes can override if needed.
  }

  protected serializeResponse (response): string {
    return JSON.stringify(response)
  }

  protected sendSuccessResponse (res: Response, content: string): Response {
    return res.type('application/json').status(200).send(content)
  }

  public getHandler (): RequestHandler {
    return this.defaultHandler.bind(this)
  }

  public getCode (): string {
    return this.capability.getCode()
  }

  public getEndpoint (): string {
    return this.endpoint
  }

  public getMethod (): 'GET' | 'POST' {
    return this.capability.getMethod()
  }

  static getNameAndDomain (params: any): { name: string, domain: string, pubkey?: string } {
    const [name, domain] = params.paymail.split('@')
    return { name, domain }
  }
}
