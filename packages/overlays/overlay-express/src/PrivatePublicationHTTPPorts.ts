import type { RequestHandler } from 'express'

export type PrivatePublicationHTTPOperation = 'publish' | 'status'
/** Supplied only after BRC-103 authentication and exact selector validation. */
export interface PrivatePublicationHTTPCaller {
  publisher: string
  capability: string
  profile: string
  current: () => boolean
  signal: AbortSignal
}
export interface PrivatePublicationHTTPService {
  publish(input: unknown, caller: PrivatePublicationHTTPCaller): Promise<unknown>
  status(input: unknown, caller: PrivatePublicationHTTPCaller): Promise<unknown>
}
export interface PrivatePublicationHTTPPrepared {
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
  enqueue(send: (body: string, headers: Readonly<Record<string, string>>) => void): void
}
export interface PrivatePublicationHTTPDisclosure {
  prepare(input: unknown, caller: PrivatePublicationHTTPCaller): PrivatePublicationHTTPPrepared
  enqueueControl(input: unknown, caller: PrivatePublicationHTTPCaller, send: () => void): void
}
export interface PrivatePublicationRouteOptions {
  service: PrivatePublicationHTTPService
  disclosure: PrivatePublicationHTTPDisclosure
  baseURL: string
  /** Share the origin's single bounded BRC-103/104 authentication instance. */
  authenticate: RequestHandler
  handleHandshake?: boolean
  /** Omitted preserves credential-free public CORS. */
  allowedOrigins?: readonly string[]
  maximumRequests?: number
  maximumWork?: number
  maximumWorkPerPrincipal?: number
  requestTimeoutMs?: number
  maximumRequestBytes?: number
  maximumResponseBytes?: number
}
