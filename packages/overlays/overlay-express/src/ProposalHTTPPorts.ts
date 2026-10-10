import type { RequestHandler } from 'express'

export type ProposalHTTPOperation = 'put' | 'get' | 'finalize'
export interface ProposalHTTPCaller {
  caller: string
  capabilityDigest: string
}
export type ProposalHTTPReference =
  | { kind: 'channel'; channelKey: string }
  | { kind: 'proposal'; proposalId: string }
  | { kind: 'control' }

/** The transport treats local journal records as opaque; their owner validates them. */
export interface ProposalHTTPJournal<Entry = unknown> {
  readonly responseEnqueue: 'proposal-journal-send/1'
  enqueueResponse(
    candidate: { reference: ProposalHTTPReference; bytes: Uint8Array },
    validate: (entry: Entry | undefined, bytes: Uint8Array) => boolean,
    enqueue: (bytes: Uint8Array) => undefined
  ): Promise<void>
}
export interface ProposalHTTPBinding<Entry = unknown> {
  readonly body: string
  readonly reference: Readonly<Exclude<ProposalHTTPReference, { kind: 'control' }>>
  validate(entry: Entry | undefined, bytes: Uint8Array, authenticatedIdentity: string): boolean
}
export interface ProposalHTTPDisclosure<Entry = unknown> {
  bind(
    operation: ProposalHTTPOperation,
    text: string,
    response: unknown,
    caller: ProposalHTTPCaller
  ): ProposalHTTPBinding<Entry>
}
export interface ProposalHTTPService {
  put(input: unknown, caller: ProposalHTTPCaller): Promise<unknown>
  get(input: unknown, caller: ProposalHTTPCaller): Promise<unknown>
  finalize(input: unknown, caller: ProposalHTTPCaller): Promise<unknown>
}
export interface ProposalRouteOptions<Entry = unknown> {
  service: ProposalHTTPService
  disclosure: ProposalHTTPDisclosure<Entry>
  /** Must be the same durable journal used by the service and every proposal writer. */
  journal: ProposalHTTPJournal<Entry>
  baseURL: string
  /** Share the origin's single bounded BRC-103/104 authentication instance. */
  authenticate: RequestHandler
  handleHandshake?: boolean
  /** Synchronous permission for sanitized control errors only, rechecked inside the journal gate. */
  authorizeControl(identity: string): boolean
  /** Omitted means credential-free public CORS; explicit lists opt into exact origins. */
  allowedOrigins?: readonly string[]
  maximumRequests?: number
  maximumWork?: number
  maximumWorkPerPrincipal?: number
  requestTimeoutMs?: number
  maximumRequestBytes?: number
  maximumResponseBytes?: number
}
