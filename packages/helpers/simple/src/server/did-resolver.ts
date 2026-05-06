/**
 * DID Resolution Proxy — server-side did:bsv resolver.
 *
 * 1. Try nChain Universal Resolver first
 * 2. On failure, fall back to WoC chain-following (server-side, no CORS)
 *
 * Core class (DIDResolverService) is framework-agnostic.
 * createDIDResolverHandler() returns Next.js App Router compatible { GET }.
 */

import { DIDResolverConfig, DIDResolutionResult } from '../core/types'
import {
  HandlerRequest,
  HandlerResponse,
  getSearchParams,
  jsonResponse,
  toNextHandlers
} from './handler-types'

const DEFAULT_RESOLVER_URL = 'https://bsvdid-universal-resolver.nchain.systems'
const DEFAULT_WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const BSVDID_MARKER = 'BSVDID'

// ============================================================================
// OP_RETURN parser
// ============================================================================

function hexToBytes (hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.substring(i, i + 2), 16))
  }
  return bytes
}

function parseOpReturnSegments (hexScript: string): string[] {
  try {
    const bytes = hexToBytes(hexScript)
    const segments: string[] = []
    let i = 0

    // Find OP_RETURN (0x6a)
    while (i < bytes.length) {
      if (bytes[i] === 0x6a) { i++; break }
      i++
    }
    if (i >= bytes.length) return []

    // Read data pushes
    while (i < bytes.length) {
      const op = bytes[i]
      i++

      let len = 0
      if (op >= 0x01 && op <= 0x4b) {
        len = op
      } else if (op === 0x4c) {
        if (i >= bytes.length) break
        len = bytes[i]; i++
      } else if (op === 0x4d) {
        if (i + 1 >= bytes.length) break
        len = bytes[i] | (bytes[i + 1] << 8); i += 2
      } else if (op === 0x4e) {
        if (i + 3 >= bytes.length) break
        len = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24); i += 4
      } else {
        break
      }

      if (i + len > bytes.length) break
      const data = bytes.slice(i, i + len)
      i += len
      segments.push(new TextDecoder().decode(new Uint8Array(data)))
    }

    return segments
  } catch {
    return []
  }
}

// ============================================================================
// DIDResolverService core class
// ============================================================================

export class DIDResolverService {
  private readonly resolverUrl: string
  private readonly wocBaseUrl: string
  private readonly resolverTimeout: number
  private readonly maxHops: number

  constructor (config?: DIDResolverConfig) {
    this.resolverUrl = config?.resolverUrl ?? DEFAULT_RESOLVER_URL
    this.wocBaseUrl = config?.wocBaseUrl ?? DEFAULT_WOC_BASE
    this.resolverTimeout = config?.resolverTimeout ?? 10_000
    this.maxHops = config?.maxHops ?? 100
  }

  async resolve (did: string): Promise<DIDResolutionResult> {
    const txidMatch = did.match(/^did:bsv:([0-9a-f]{64})$/i)

    // Try nChain Universal Resolver
    try {
      const response = await fetch(
        `${this.resolverUrl}/1.0/identifiers/${encodeURIComponent(did)}`,
        {
          headers: { Accept: 'application/did+ld+json' },
          signal: AbortSignal.timeout(this.resolverTimeout)
        }
      )

      if (response.ok) {
        const data: any = await response.json()
        return {
          didDocument: data.didDocument ?? data,
          didDocumentMetadata: data.didDocumentMetadata ?? {},
          didResolutionMetadata: {
            contentType: 'application/did+ld+json',
            ...(data.didResolutionMetadata ?? {})
          }
        }
      }

      if (response.status === 410) {
        const data: any = await response.json().catch(() => ({}))
        return {
          didDocument: data.didDocument ?? null,
          didDocumentMetadata: { deactivated: true, ...(data.didDocumentMetadata ?? {}) },
          didResolutionMetadata: {
            contentType: 'application/did+ld+json',
            ...(data.didResolutionMetadata ?? {})
          }
        }
      }
    } catch {
      // nChain timeout/error — fall through to WoC
    }

    // WoC chain-following fallback
    if (txidMatch != null) {
      return await this.resolveViaWoC(txidMatch[1].toLowerCase())
    }

    return {
      didDocument: null,
      didDocumentMetadata: {},
      didResolutionMetadata: { error: 'notFound', message: 'DID could not be resolved' }
    }
  }

  private async resolveViaWoC (txid: string): Promise<DIDResolutionResult> {
    const notFound: DIDResolutionResult = {
      didDocument: null,
      didDocumentMetadata: {},
      didResolutionMetadata: { error: 'notFound', message: 'DID not found on chain' }
    }

    let currentTxid = txid
    let lastDocument: any = null
    let lastDocTxid: string | undefined
    let created: string | undefined
    let updated: string | undefined
    let foundIssuance = false
    const visited = new Set<string>()

    for (let hop = 0; hop < this.maxHops; hop++) {
      if (visited.has(currentTxid)) break
      visited.add(currentTxid)

      const txResp = await fetch(`${this.wocBaseUrl}/tx/${currentTxid}`)
      if (!txResp.ok) return notFound
      const txData: any = await txResp.json()

      if (created == null) {
        created = (txData.time != null) ? new Date(txData.time * 1000).toISOString() : undefined
      }

      // Parse OP_RETURN outputs
      let segments: string[] = []
      for (const vout of (txData.vout as any[] | null) ?? []) {
        const hex = vout?.scriptPubKey?.hex as string | undefined
        if (hex == null || hex === '') continue
        const s = parseOpReturnSegments(hex)
        if (s.length >= 3 && s[0] === BSVDID_MARKER) {
          segments = s
          break
        }
      }

      if (segments.length >= 3) {
        const payload = segments[2]

        if (payload === '3') {
          return {
            didDocument: lastDocument,
            didDocumentMetadata: { created, updated, deactivated: true, versionId: currentTxid },
            didResolutionMetadata: { contentType: 'application/did+ld+json' }
          }
        }

        if (payload === '1') {
          foundIssuance = true
        } else if (payload !== '2') {
          try {
            lastDocument = JSON.parse(payload)
            lastDocTxid = currentTxid
            updated = (txData.time != null) ? new Date(txData.time * 1000).toISOString() : undefined
          } catch {
            // Not valid JSON
          }
        }
      }

      // Follow output 0 spend chain
      let nextTxid: string | null = null

      // Strategy 1: spend endpoint
      try {
        const spendResp = await fetch(`${this.wocBaseUrl}/tx/${currentTxid}/out/0/spend`)
        if (spendResp.ok && spendResp.status !== 404) {
          const spendData: any = await spendResp.json()
          nextTxid = spendData?.txid ?? null
        }
      } catch { /* fall through */ }

      // Strategy 2: address history fallback
      if (nextTxid == null) {
        const out0Addr = txData.vout?.[0]?.scriptPubKey?.addresses?.[0]
        if (out0Addr != null) {
          try {
            const histResp = await fetch(`${this.wocBaseUrl}/address/${String(out0Addr)}/history`)
            if (histResp.ok) {
              const history = (await histResp.json()) as Array<{ tx_hash: string, height: number }>
              const candidates = history
                .filter(e => !visited.has(e.tx_hash))
                .sort((a, b) => (b.height !== 0 ? b.height : 0) - (a.height !== 0 ? a.height : 0))
              if (candidates.length > 0) {
                nextTxid = candidates[0].tx_hash
              }
            }
          } catch { /* address history unavailable */ }
        }
      }

      if (nextTxid == null) break
      currentTxid = nextTxid
    }

    if (lastDocument != null) {
      return {
        didDocument: lastDocument,
        didDocumentMetadata: { created, updated, versionId: lastDocTxid },
        didResolutionMetadata: { contentType: 'application/did+ld+json' }
      }
    }

    if (foundIssuance) {
      return {
        didDocument: null,
        didDocumentMetadata: { created },
        didResolutionMetadata: {
          error: 'notYetAvailable',
          message: 'DID issuance found on chain but document transaction has not propagated yet. Try again shortly.'
        }
      }
    }

    return notFound
  }
}

// ============================================================================
// Next.js handler factory
// ============================================================================

export function createDIDResolverHandler (config?: DIDResolverConfig): ReturnType<typeof toNextHandlers> {
  const resolver = new DIDResolverService(config)

  const coreHandlers = {
    async GET (req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const did = params.get('did')

      if (did == null || did === '') {
        return jsonResponse({ error: 'Missing "did" query parameter' }, 400)
      }

      try {
        const result = await resolver.resolve(did)
        const status = result.didResolutionMetadata.error === 'notFound'
          ? 404
          : (result.didResolutionMetadata.error === 'internalError'
              ? 502
              : 200)
        return jsonResponse(result, status)
      } catch (error) {
        return jsonResponse({
          didDocument: null,
          didDocumentMetadata: {},
          didResolutionMetadata: {
            error: 'internalError',
            message: `Resolution failed: ${(error as Error).message}`
          }
        }, 502)
      }
    }
  }

  return toNextHandlers(coreHandlers)
}
