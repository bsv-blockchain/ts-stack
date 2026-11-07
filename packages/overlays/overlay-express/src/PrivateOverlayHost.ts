import type { RequestHandler, Router } from 'express'
import { outputIdentity } from '@bsv/sdk'
import type { PrivateAcquisitionRouteOptions } from './PrivateAcquisitionHTTPPorts.js'
import type { PrivatePublicationRouteOptions } from './PrivatePublicationHTTPPorts.js'
import type { PrivatePurchaseRouteOptions } from './PrivatePurchaseHTTPPorts.js'
import { createPrivateAcquisitionRouter } from './PrivateAcquisitionRoutes.js'
import { createPrivatePublicationRouter } from './PrivatePublicationRoutes.js'
import { createPrivatePurchaseRouter } from './PrivatePurchaseRoutes.js'

export type PrivateAcquisitionHostOptions = Omit<
  PrivateAcquisitionRouteOptions,
  'authenticate' | 'handleHandshake'
> & { identity: string }
export type PrivatePublicationHostOptions = Omit<
  PrivatePublicationRouteOptions,
  'authenticate' | 'handleHandshake'
> & { identity: string }
export type PrivatePurchaseHostOptions = Omit<
  PrivatePurchaseRouteOptions,
  'authenticate' | 'handleHandshake'
>
export interface PrivateOverlayHostOptions {
  acquisition?: PrivateAcquisitionHostOptions
  publication?: PrivatePublicationHostOptions
  purchase?: PrivatePurchaseHostOptions
}
export interface PrivateOverlayHostLimits {
  request: number
  response: number
  origins?: readonly string[] | '*'
}

/** Selected only by explicit host configuration; legacy imports do not load these profiles. */
export class PrivateOverlayHost {
  private readonly options: PrivateOverlayHostOptions
  /** BRC-105 payment evidence travels in a bounded header; ordinary startup keeps Node's default. */
  readonly maximumHeaderBytes: number | undefined
  constructor(options: PrivateOverlayHostOptions) {
    this.options = {
      ...(options.acquisition ? { acquisition: own(options.acquisition) } : {}),
      ...(options.publication ? { publication: own(options.publication) } : {}),
      ...(options.purchase ? { purchase: own(options.purchase) } : {})
    }
    this.maximumHeaderBytes = this.options.acquisition ? 131072 : undefined
  }
  requireIdentity(identity: string): void {
    const selected = outputIdentity(identity)
    for (const options of [
      this.options.acquisition,
      this.options.publication,
      this.options.purchase
    ])
      if (options && options.identity !== selected)
        throw new Error('Private overlay identity must match the server authentication wallet')
  }
  routes(
    authenticate: RequestHandler,
    handleHandshake: boolean,
    limits: PrivateOverlayHostLimits
  ): Router[] {
    const routers: Router[] = []
    const acquisition = this.options.acquisition,
      publication = this.options.publication,
      purchase = this.options.purchase
    const selected = <
      T extends
        PrivateAcquisitionHostOptions | PrivatePublicationHostOptions | PrivatePurchaseHostOptions
    >(
      options: T
    ) => {
      const origins = options.allowedOrigins ?? limits.origins
      return {
        ...options,
        authenticate,
        handleHandshake: handleHandshake && routers.length === 0,
        allowedOrigins: origins === '*' ? undefined : origins,
        maximumRequestBytes: Math.min(options.maximumRequestBytes ?? 4194304, limits.request),
        maximumResponseBytes: Math.min(options.maximumResponseBytes ?? 4194304, limits.response)
      }
    }
    // Publication's established router owns the shared private namespace fallback.
    // Register the acquisition operations first and give exactly one router handshake ownership.
    if (acquisition) routers.push(createPrivateAcquisitionRouter(selected(acquisition)))
    if (purchase) routers.push(createPrivatePurchaseRouter(selected(purchase)))
    if (publication) routers.push(createPrivatePublicationRouter(selected(publication)))
    return routers
  }
}
function own<
  T extends
    PrivateAcquisitionHostOptions | PrivatePublicationHostOptions | PrivatePurchaseHostOptions
>(options: T): T {
  outputIdentity(options.identity)
  if (options.allowedOrigins !== undefined && !Array.isArray(options.allowedOrigins))
    throw new TypeError('Private overlay origins must be an array')
  return {
    ...options,
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: [...options.allowedOrigins] })
  }
}
