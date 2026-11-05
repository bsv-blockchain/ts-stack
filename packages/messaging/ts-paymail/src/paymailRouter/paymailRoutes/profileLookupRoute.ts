import type { NextFunction, Request, Response } from 'express'
import PaymailRoute from './paymailRoute.js'
import ProfileLookupCapability from '../../capability/profileLookupCapability.js'
import {
  PROFILE_LOOKUP_MAX_RESULTS,
  checkProfileCertificate,
  normalizeProfileLookupQuery
} from '../../profileCertificate.js'

/**
 * Answers a normalized handle query with profile certificates, best match
 * first. Return certificates as stored; the route drops any that are not
 * servable BRC-235 profiles for the configured domain.
 */
export type ProfileLookupHandler = (query: string) => unknown[] | Promise<unknown[]>

interface ProfileLookupRouteConfig {
  /** The paymail domain this host serves, e.g. `example.com`. */
  domain: string
  domainLogicHandler: ProfileLookupHandler
  endpoint?: string
}

/**
 * BRC-235 public profile lookup (`0ace65da5987`). Hostable on its own: it
 * needs no other Paymail capability.
 */
export default class ProfileLookupRoute extends PaymailRoute {
  private readonly domain: string
  private readonly lookup: ProfileLookupHandler

  constructor(config: ProfileLookupRouteConfig) {
    const endpoint = config.endpoint ?? '/handle/:query'
    if (!endpoint.includes(':query')) {
      throw new Error('Profile lookup endpoint must contain the :query parameter')
    }
    if (typeof config.domain !== 'string' || config.domain.trim() === '') {
      throw new Error('Profile lookup route requires the paymail domain it serves')
    }
    if (typeof config.domainLogicHandler !== 'function') {
      throw new TypeError('Profile lookup route requires a domainLogicHandler function')
    }
    super({
      capability: ProfileLookupCapability,
      endpoint,
      domainLogicHandler: params => config.domainLogicHandler(params.query)
    })
    this.domain = config.domain.trim().toLowerCase()
    this.lookup = config.domainLogicHandler
  }

  protected override async defaultHandler(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const raw = req.params.query
      const query =
        typeof raw === 'string' ? normalizeProfileLookupQuery(raw, this.domain) : undefined
      if (query === undefined) {
        this.sendSuccessResponse(res, '[]')
        return
      }
      const results = await this.lookup(query)
      if (!Array.isArray(results)) {
        throw new TypeError('Profile lookup handler must return an array of certificates')
      }
      const certificates = []
      for (const result of results) {
        if (certificates.length >= PROFILE_LOOKUP_MAX_RESULTS) break
        const certificate = checkProfileCertificate(result, this.domain)
        if (certificate !== undefined) certificates.push(certificate)
      }
      this.sendSuccessResponse(res, JSON.stringify(certificates))
    } catch (error) {
      next(error)
    }
  }
}
