import {
  canonicalOutputJSON,
  closedOutputObject,
  outputPacketDigest,
  OutputProtocolError,
  Utils,
  validateWalletArgs,
  validateWalletResult,
  type ListOutputsArgs,
  type WalletInterface
} from '@bsv/sdk'
import { SourceSession, type SourceBinding } from './SourceSession.js'
import type { OutputObservation, Source, SourceBatch, SourceRequest } from '../ports.js'

export type WalletOutputQuery = Omit<ListOutputsArgs, 'include' | 'limit' | 'offset'>
export const WALLET_OUTPUT_CONTEXT_SCHEMA = 'urn:bsv:output-knowledge:wallet-output-json:1'
export interface WalletOutputSourceOptions extends SourceBinding {
  wallet: Pick<WalletInterface, 'listOutputs'>
  query: WalletOutputQuery
  originator?: string
  pageSize?: number
  maximumPages?: number
}

function ownedQuery(input: WalletOutputQuery): WalletOutputQuery {
  const query: unknown = JSON.parse(canonicalOutputJSON(input))
  closedOutputObject(
    query,
    ['basket'],
    [
      'tags',
      'tagQueryMode',
      'includeCustomInstructions',
      'includeTags',
      'includeLabels',
      'seekPermission'
    ]
  )
  validateWalletArgs('listOutputs', query)
  return query as unknown as WalletOutputQuery
}

/** Pagination belongs to transport; the digest binds the stable basket/filter query. */
export function walletOutputQueryDigest(service: string, query: WalletOutputQuery): string {
  return outputPacketDigest('lookup-query', { service, query: ownedQuery(query) })
}

/**
 * Finite BRC-100 offset pages with exact aggregate-BEEF targets. Completion means
 * this bounded invocation settled, never an atomic wallet snapshot or a spend.
 */
export class WalletOutputSource implements Source {
  readonly id: string
  private readonly session: SourceSession
  private readonly query: WalletOutputQuery
  private readonly pageSize: number
  private readonly maximumPages: number
  private readonly wallet: WalletOutputSourceOptions['wallet']
  private readonly originator: string | undefined

  constructor(options: WalletOutputSourceOptions) {
    this.session = new SourceSession(options)
    this.id = this.session.id
    this.query = ownedQuery(options.query)
    this.pageSize = options.pageSize ?? 100
    this.maximumPages = options.maximumPages ?? 32
    this.wallet = options.wallet
    this.originator = options.originator
    for (const [value, bound] of [
      [this.pageSize, 1024],
      [this.maximumPages, 128]
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > bound)
        throw new OutputProtocolError('invalid', 'Invalid wallet page bound')
    if (
      this.session.scope.queryDigest !==
      walletOutputQueryDigest(this.session.scope.service, this.query)
    )
      throw new OutputProtocolError('invalid', 'Wallet query differs from configured digest')
  }

  async *open(input: SourceRequest, signal: AbortSignal): AsyncIterable<SourceBatch> {
    const request = this.session.begin(input, signal),
      limit = Math.min(this.pageSize, request.limits.observations),
      deadline = this.session.now() + request.limits.deadlineMs
    let offset = 0,
      bytes = 0
    try {
      for (let page = 0; page < this.maximumPages; page++) {
        this.session.check(signal)
        const remaining = Math.floor(deadline - this.session.now())
        if (remaining < 1) {
          yield this.session.batch(request, [], 'limited')
          return
        }
        const args: ListOutputsArgs = {
            ...this.query,
            include: 'entire transactions',
            limit,
            offset
          },
          raw = await this.session.call(
            () => this.wallet.listOutputs(args, this.originator),
            signal,
            remaining
          )
        this.session.check(signal)
        const result = validateWalletResult('listOutputs', raw, args),
          beef = Utils.toBase64(result.BEEF ?? []),
          observations: OutputObservation[] = result.outputs.map((row, index) => {
            const [txid, outputIndex] = row.outpoint.split('.')
            return {
              id: `wallet:${request.generation}:${page}:${index}`,
              scope: this.session.scope,
              kind: 'output',
              payload: {
                evidence: { txid: txid.toLowerCase(), outputIndex: Number(outputIndex), beef },
                context: {
                  schema: WALLET_OUTPUT_CONTEXT_SCHEMA,
                  bytes: Utils.toBase64(Utils.toArray(JSON.stringify(row), 'utf8'))
                }
              }
            }
          }),
          batch = this.session.batch(
            request,
            observations.length
              ? [
                  {
                    id: `wallet-page:${request.generation}:${page}`,
                    sequence: '0',
                    observations
                  }
                ]
              : []
          )
        bytes += new TextEncoder().encode(canonicalOutputJSON(batch)).length
        if (bytes > request.limits.pendingBytes) {
          yield this.session.batch(request, [], 'limited')
          return
        }
        if (observations.length) yield batch
        // The result count is a moving wallet estimate, not a snapshot watermark.
        offset += result.outputs.length
        if (result.outputs.length < limit || offset >= result.totalOutputs) {
          yield this.session.batch(request, [], 'complete')
          return
        }
      }
      yield this.session.batch(request, [], 'limited')
    } finally {
      this.session.end()
    }
  }
}
