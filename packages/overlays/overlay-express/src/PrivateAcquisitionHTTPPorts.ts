import type { RequestHandler } from 'express'

export type PrivateAcquisitionHTTPOperation = 'acquire' | 'recover'
/** Supplied only after BRC-103 authentication and exact selector validation. */
export interface PrivateAcquisitionHTTPCaller {
  buyer: string
  capability: string
  profile: string
  current: () => boolean
  signal: AbortSignal
}
export interface PrivateAcquisitionHTTPService {
  acquire(
    input: unknown,
    payment: unknown | undefined,
    caller: PrivateAcquisitionHTTPCaller
  ): Promise<string>
  recover(acquisitionId: string, caller: PrivateAcquisitionHTTPCaller): Promise<string>
}
export interface PrivateAcquisitionHTTPPrepared {
  readonly statusCode: 200 | 402
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
  enqueue(send: (body: string, headers: Readonly<Record<string, string>>) => void): void
}
export interface PrivateAcquisitionHTTPDisclosure {
  prepare(
    acquisitionId: string,
    caller: PrivateAcquisitionHTTPCaller,
    options?: { challenge?: boolean }
  ): PrivateAcquisitionHTTPPrepared
  enqueueControl(input: unknown, caller: PrivateAcquisitionHTTPCaller, send: () => void): void
}
export interface PrivateAcquisitionRouteOptions {
  service: PrivateAcquisitionHTTPService
  disclosure: PrivateAcquisitionHTTPDisclosure
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
