import type { NextFunction, Request, Response } from 'express'
import PaymailRoute from './paymailRoute.js'
import ProfileReverseLookupCapability from '../../capability/profileReverseLookupCapability.js'
import { checkProfileCertificate, isProfileIdentityKey } from '../../profileCertificate.js'

/**
 * Answers the current profile certificate of an identity key at this host, or
 * null/undefined when the key holds no handle here. It may return a promise.
 */
export type ProfileReverseLookupHandler = (identityKey: string) => unknown

interface ProfileReverseLookupRouteConfig {
  /** The paymail domain this host serves, e.g. `example.com`. */
  domain: string
  domainLogicHandler: ProfileReverseLookupHandler
  endpoint?: string
}

function sendError(res: Response, status: number, code: string, description: string): void {
  res
    .type('application/json')
    .status(status)
    .send(JSON.stringify({ status: 'error', code, description }))
}

/**
 * BRC-235 public profile reverse lookup (`43dcf83ddc5f`). Hostable on its own:
 * it needs no other Paymail capability.
 */
export default class ProfileReverseLookupRoute extends PaymailRoute {
  private readonly domain: string
  private readonly reverseLookup: ProfileReverseLookupHandler

  constructor(config: ProfileReverseLookupRouteConfig) {
    const endpoint = config.endpoint ?? '/identityKey/:pubkey'
    if (!endpoint.includes(':pubkey')) {
      throw new Error('Profile reverse lookup endpoint must contain the :pubkey parameter')
    }
    if (typeof config.domain !== 'string' || config.domain.trim() === '') {
      throw new Error('Profile reverse lookup route requires the paymail domain it serves')
    }
    if (typeof config.domainLogicHandler !== 'function') {
      throw new TypeError('Profile reverse lookup route requires a domainLogicHandler function')
    }
    super({
      capability: ProfileReverseLookupCapability,
      endpoint,
      domainLogicHandler: params => config.domainLogicHandler(params.pubkey)
    })
    this.domain = config.domain.trim().toLowerCase()
    this.reverseLookup = config.domainLogicHandler
  }

  protected override async defaultHandler(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const raw = req.params.pubkey
      const identityKey = typeof raw === 'string' ? raw.toLowerCase() : ''
      if (!isProfileIdentityKey(identityKey)) {
        sendError(
          res,
          400,
          'ERR_INVALID_LOOKUP',
          'Expected a 33-byte compressed public key in hex.'
        )
        return
      }
      const result = await this.reverseLookup(identityKey)
      if (result == null) {
        sendError(res, 404, 'ERR_HANDLE_NOT_FOUND', 'No active handle.')
        return
      }
      const certificate = checkProfileCertificate(result, this.domain)
      if (certificate?.subject.toLowerCase() !== identityKey) {
        throw new Error('Profile reverse lookup handler returned an unservable certificate')
      }
      this.sendSuccessResponse(res, JSON.stringify(certificate))
    } catch (error) {
      next(error)
    }
  }
}
