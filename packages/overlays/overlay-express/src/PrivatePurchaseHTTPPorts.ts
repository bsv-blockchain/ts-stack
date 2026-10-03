import type { RequestHandler } from 'express'

export type PrivatePurchaseHTTPOperation = 'prepare' | 'submit' | 'recover'
export interface PrivatePurchaseHTTPCaller {
  buyer: string
  capability: string
  profile: string
  current: () => boolean
  signal: AbortSignal
}
export interface PrivatePurchaseHTTPService {
  prepare(input: unknown, caller: PrivatePurchaseHTTPCaller): Promise<string>
  submit(input: unknown, caller: PrivatePurchaseHTTPCaller): Promise<string>
  recover(acquisitionId: string, caller: PrivatePurchaseHTTPCaller): Promise<string>
}
export interface PrivatePurchaseHTTPPrepared {
  readonly statusCode: 200
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
  enqueue(send: (body: string, headers: Readonly<Record<string, string>>) => void): void
}
export interface PrivatePurchaseHTTPDisclosure {
  prepare(
    acquisitionId: string,
    caller: PrivatePurchaseHTTPCaller,
    options?: { terms?: boolean }
  ): PrivatePurchaseHTTPPrepared
  enqueueControl(input: unknown, caller: PrivatePurchaseHTTPCaller, send: () => void): void
}
export interface PrivatePurchaseRouteOptions {
  service: PrivatePurchaseHTTPService
  disclosure: PrivatePurchaseHTTPDisclosure
  baseURL: string
  /** Installed seller, independently matched to the host authentication wallet. */
  identity: string
  authenticate: RequestHandler
  handleHandshake?: boolean
  allowedOrigins?: readonly string[]
  maximumRequests?: number
  maximumWork?: number
  maximumWorkPerPrincipal?: number
  requestTimeoutMs?: number
  maximumRequestBytes?: number
  maximumResponseBytes?: number
}
