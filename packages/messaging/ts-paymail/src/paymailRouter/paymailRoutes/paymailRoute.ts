import type { NextFunction, Request, RequestHandler, Response } from 'express'
import Capability from '../../capability/capability.js'
import { PaymailBadRequestError } from '../../errors/index.js'
import { parsePaymail } from '../../paymailAddress.js'

interface PaymailRouteConfig {
  capability: Capability
  endpoint: string
  domainLogicHandler: DomainLogicHandler
}

export interface PaymailRouteParams {
  [key: string]: string
  paymail: string
}

export type DomainLogicHandler = (
  params: PaymailRouteParams,
  body?: unknown,
  pubkey?: string
) => unknown

export default class PaymailRoute {
  private readonly capability: Capability
  private readonly endpoint: string
  protected readonly domainLogicHandler: DomainLogicHandler

  constructor(config: PaymailRouteConfig) {
    this.capability = config.capability
    this.endpoint = this.validateEndpoint(config.endpoint)
    this.domainLogicHandler = config.domainLogicHandler
  }

  private validateEndpoint(endpoint: string): string {
    if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('/')) {
      throw new Error('Invalid endpoint: Endpoint must be a non-empty string starting with "/".')
    }
    return endpoint
  }

  protected async defaultHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      let validatedBody: unknown
      try {
        validatedBody = await this.validateBody(req.body)
      } catch (error) {
        if (error instanceof PaymailBadRequestError) throw error
        throw new PaymailBadRequestError(error instanceof Error ? error.message : String(error))
      }
      if (!req.params.paymail) {
        throw new PaymailBadRequestError('Paymail handle is required.')
      }
      const response = await this.domainLogicHandler(
        req.params as PaymailRouteParams,
        validatedBody
      )
      const serializedResponse = this.serializeResponse(response)
      this.sendSuccessResponse(res, serializedResponse)
    } catch (error) {
      next(error)
    }
  }

  protected async validateBody(body: unknown): Promise<unknown> {
    return body
  }

  protected serializeResponse(response: unknown): string {
    return JSON.stringify(response)
  }

  protected sendSuccessResponse(res: Response, content: string): Response {
    return res.type('application/json').status(200).send(content)
  }

  public getHandler(): RequestHandler {
    return this.defaultHandler.bind(this)
  }

  public getCode(): string {
    return this.capability.getCode()
  }

  public getEndpoint(): string {
    return this.endpoint
  }

  public getMethod(): 'GET' | 'POST' {
    return this.capability.getMethod()
  }

  static getNameAndDomain(params: PaymailRouteParams): {
    name: string
    domain: string
    pubkey?: string
  } {
    const parsed = parsePaymail(params.paymail)
    if (!parsed) throw new PaymailBadRequestError('Invalid Paymail handle.')
    return parsed
  }
}
