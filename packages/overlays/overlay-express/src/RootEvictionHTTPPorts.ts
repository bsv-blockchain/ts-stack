import type { RequestHandler } from 'express'

/** Structural journal port: main host declarations do not require optional SDK types. */
export interface RootEvictionHTTPJournal {
  head(): Promise<{ revision: string }>
  enqueue(
    candidate: {
      revision: string
      targets: {
        service: 'ls_ship' | 'ls_slap'
        outpoint: {
          chain: { network: string; genesisHash: string }
          txid: string
          outputIndex: number
        }
        advertisementDigest: string
      }[]
      bytes: Uint8Array
    },
    authorize: () => boolean,
    enqueue: (bytes: Uint8Array) => undefined
  ): Promise<void>
}

export interface RootEvictionHTTPAccess {
  operation: 'submit' | 'status'
  principal: string
  requester: string
  requestId: string
}
export interface RootEvictionHTTPResponse {
  body: string
  headers: Record<string, string>
  head: { revision: string }
  access: RootEvictionHTTPAccess
}
/** Structural port preserves this package's ESM and CommonJS support. */
export interface RootEvictionHTTPCompanion {
  submit(
    text: string,
    caller: { principal: string; capabilityDigest: string },
    manifest: unknown,
    signal?: AbortSignal
  ): Promise<RootEvictionHTTPResponse>
  status(
    text: string,
    caller: { principal: string; capabilityDigest: string },
    signal?: AbortSignal
  ): Promise<RootEvictionHTTPResponse>
}
export interface RootEvictionRouteOptions {
  /** Share one bounded service instance across requests. */
  companion: RootEvictionHTTPCompanion
  /** The same durable journal and gate used by the companion and all serving paths. */
  journal: RootEvictionHTTPJournal
  baseURL: string
  /** Must be the same BRC-103/104 middleware instance used for this origin's handshake. */
  authenticate: RequestHandler
  /** Defaults to true; mount the origin's handshake exactly once. */
  handleHandshake?: boolean
  /** Synchronous local snapshot only. Return undefined during discovery unavailability. */
  manifest(): unknown
  /**
   * Synchronous current authority at native enqueue, including current policy/context.
   * Undefined access requests permission for a sanitized control error only.
   * Coordinate authorization changes with the journal's decision/send gate.
   */
  authorize(identity: string, access: Readonly<RootEvictionHTTPAccess> | undefined): boolean
  /** Omit for public credential-free CORS. An explicit list opts into exact origins. */
  allowedOrigins?: readonly string[]
  maximumRequests?: number
  maximumRequestBytes?: number
  maximumResponseBytes?: number
}
