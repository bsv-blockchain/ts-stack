import {
  TransportStatusError,
  type HostTransport,
  type TransportResponse
} from '../../src/client/transport.js'
import {
  createEconomicQueryHost,
  type EconomicQueryHost,
  type EconomicQueryHostOptions
} from '../../src/host/handlers.js'
import { parseHostParams, type HostParams } from '../../src/protocol/params.js'
import { ECONOMIC_PATHS } from '../../src/protocol/query.js'
import { HostWallet } from './wallets.js'

export interface LoopbackHost {
  url: string
  wallet: HostWallet
  host: EconomicQueryHost
  /** Delay before every authenticated response. */
  delayMs: number
  down: boolean
  withoutMarket: boolean
  /** Params reads that fail with a plain error before the host answers normally again. */
  transientParamsFailures: number
  /** Params reads that reached this host, cache misses only. */
  paramsReads: number
  /** Identity key the transport reports for the session, to simulate a spoof. */
  sessionIdentity?: string
  /** Rewrites a successful collect body, to simulate a host that serves wrong bytes. */
  tamperDelivery?: (body: Record<string, unknown>) => Record<string, unknown>
  posts: Array<{ path: string; body: unknown }>
}

interface Captured {
  status: number
  body: unknown
}

function capture(): Captured & {
  response: {
    status: (code: number) => unknown
    json: (body: unknown) => unknown
    set: () => unknown
  }
} {
  const captured: Captured = { status: 0, body: undefined }
  const response = {
    status(code: number) {
      captured.status = code
      return response
    },
    json(body: unknown) {
      captured.body = JSON.parse(JSON.stringify(body))
      return response
    },
    set() {
      return response
    }
  }
  return Object.assign(captured, { response })
}

/** Routes transport calls straight into real host handlers, without HTTP or BRC-103. */
export class LoopbackNetwork implements HostTransport {
  readonly hosts = new Map<string, LoopbackHost>()

  constructor(private readonly clientIdentityKey: string) {}

  add(
    url: string,
    options: Omit<EconomicQueryHostOptions, 'wallet'>,
    behaviour: Partial<
      Pick<LoopbackHost, 'delayMs' | 'down' | 'withoutMarket' | 'transientParamsFailures'>
    > = {}
  ): LoopbackHost {
    const wallet = new HostWallet()
    const entry: LoopbackHost = {
      url,
      wallet,
      host: createEconomicQueryHost({ logger: { error: () => undefined }, ...options, wallet }),
      delayMs: 0,
      down: false,
      withoutMarket: false,
      transientParamsFailures: 0,
      paramsReads: 0,
      posts: [],
      ...behaviour
    }
    this.hosts.set(url, entry)
    return entry
  }

  async getParams(url: string): Promise<HostParams> {
    const entry = this.hosts.get(url)
    if (entry !== undefined) entry.paramsReads += 1
    if (entry === undefined || entry.down || entry.withoutMarket) {
      throw new TransportStatusError(url, 404)
    }
    if (entry.transientParamsFailures > 0) {
      entry.transientParamsFailures -= 1
      throw new Error(`${url} dropped the params connection`)
    }
    const captured = capture()
    await entry.host.params({ headers: {} }, captured.response as never)
    return parseHostParams(captured.body)
  }

  async post(url: string, path: string, body: unknown): Promise<TransportResponse> {
    const entry = this.hosts.get(url)
    if (entry === undefined || entry.down) throw new Error(`${url} is unreachable`)
    entry.posts.push({ path, body })
    if (entry.delayMs > 0) await new Promise(resolve => setTimeout(resolve, entry.delayMs))
    const captured = capture()
    const request = {
      body: JSON.parse(JSON.stringify(body)),
      headers: {},
      auth: { identityKey: this.clientIdentityKey }
    }
    const handler = path === ECONOMIC_PATHS.query ? entry.host.query : entry.host.collect
    await handler(request, captured.response as never)
    let responseBody = captured.body
    if (
      path === ECONOMIC_PATHS.collect &&
      captured.status === 200 &&
      entry.tamperDelivery !== undefined
    ) {
      responseBody = entry.tamperDelivery(responseBody as Record<string, unknown>)
    }
    return {
      status: captured.status,
      body: responseBody,
      identityKey: entry.sessionIdentity ?? entry.wallet.identityKey
    }
  }
}
