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
const DID_CONTENT_TYPE = 'application/did+ld+json'

// ============================================================================
// OP_RETURN parser
// ============================================================================

function hexToBytes(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.substring(i, i + 2), 16))
  }
  return bytes
}

interface PushLength {
  length: number
  dataStart: number
}

function readPushLength(bytes: number[], opcodeIndex: number): PushLength | null {
  const op = bytes[opcodeIndex]
  const firstLengthByte = opcodeIndex + 1

  if (op >= 0x01 && op <= 0x4b) {
    return { length: op, dataStart: firstLengthByte }
  }
  if (op === 0x4c && firstLengthByte < bytes.length) {
    return { length: bytes[firstLengthByte], dataStart: firstLengthByte + 1 }
  }
  if (op === 0x4d && firstLengthByte + 1 < bytes.length) {
    return {
      length: bytes[firstLengthByte] | (bytes[firstLengthByte + 1] << 8),
      dataStart: firstLengthByte + 2
    }
  }
  if (op === 0x4e && firstLengthByte + 3 < bytes.length) {
    return {
      length:
        bytes[firstLengthByte] |
        (bytes[firstLengthByte + 1] << 8) |
        (bytes[firstLengthByte + 2] << 16) |
        (bytes[firstLengthByte + 3] << 24),
      dataStart: firstLengthByte + 4
    }
  }
  return null
}

function parseOpReturnSegments(hexScript: string): string[] {
  try {
    const bytes = hexToBytes(hexScript)
    const segments: string[] = []
    const opReturnIndex = bytes.indexOf(0x6a)
    if (opReturnIndex < 0 || opReturnIndex + 1 >= bytes.length) return []

    // Read data pushes
    let opcodeIndex = opReturnIndex + 1
    while (opcodeIndex < bytes.length) {
      const push = readPushLength(bytes, opcodeIndex)
      if (push == null || push.dataStart + push.length > bytes.length) break
      const data = bytes.slice(push.dataStart, push.dataStart + push.length)
      opcodeIndex = push.dataStart + push.length
      segments.push(new TextDecoder().decode(new Uint8Array(data)))
    }

    return segments
  } catch {
    return []
  }
}

interface WocChainState {
  lastDocument: any
  lastDocTxid: string | undefined
  created: string | undefined
  updated: string | undefined
  foundIssuance: boolean
}

function notFoundResult(): DIDResolutionResult {
  return {
    didDocument: null,
    didDocumentMetadata: {},
    didResolutionMetadata: { error: 'notFound', message: 'DID not found on chain' }
  }
}

function extractBsvdidSegments(vout: any[]): string[] {
  for (const output of vout) {
    const hex = output?.scriptPubKey?.hex as string | undefined
    if (hex == null || hex === '') continue
    const segments = parseOpReturnSegments(hex)
    if (segments.length >= 3 && segments[0] === BSVDID_MARKER) return segments
  }
  return []
}

function processWocSegments(
  segments: string[],
  txData: any,
  currentTxid: string,
  state: WocChainState
): DIDResolutionResult | null {
  if (segments.length < 3) return null
  const payload = segments[2]
  const timestamp = txData.time == null ? undefined : new Date(txData.time * 1000).toISOString()

  if (payload === '3') {
    return {
      didDocument: state.lastDocument,
      didDocumentMetadata: {
        created: state.created,
        updated: state.updated,
        deactivated: true,
        versionId: currentTxid
      },
      didResolutionMetadata: { contentType: DID_CONTENT_TYPE }
    }
  }

  if (payload === '1') {
    state.foundIssuance = true
  } else if (payload !== '2') {
    try {
      state.lastDocument = JSON.parse(payload)
      state.lastDocTxid = currentTxid
      state.updated = timestamp
    } catch {
      // Not valid JSON
    }
  }
  return null
}

async function fetchNextTxidViaSpend(
  wocBaseUrl: string,
  currentTxid: string
): Promise<string | null> {
  try {
    const response = await fetch(`${wocBaseUrl}/tx/${currentTxid}/out/0/spend`)
    if (!response.ok || response.status === 404) return null
    const data: any = await response.json()
    return data?.txid ?? null
  } catch {
    return null
  }
}

async function fetchNextTxidViaHistory(
  wocBaseUrl: string,
  txData: any,
  visited: Set<string>
): Promise<string | null> {
  const out0Address = txData.vout?.[0]?.scriptPubKey?.addresses?.[0]
  if (out0Address == null) return null

  try {
    const response = await fetch(`${wocBaseUrl}/address/${String(out0Address)}/history`)
    if (!response.ok) return null
    const history = (await response.json()) as Array<{ tx_hash: string; height: number }>
    const candidates = history
      .filter(entry => !visited.has(entry.tx_hash))
      .sort((left, right) => right.height - left.height)
    return candidates.length === 0 ? null : candidates[0].tx_hash
  } catch {
    return null
  }
}

function finalChainResult(state: WocChainState): DIDResolutionResult | null {
  if (state.lastDocument != null) {
    return {
      didDocument: state.lastDocument,
      didDocumentMetadata: {
        created: state.created,
        updated: state.updated,
        versionId: state.lastDocTxid
      },
      didResolutionMetadata: { contentType: DID_CONTENT_TYPE }
    }
  }

  if (!state.foundIssuance) return null
  return {
    didDocument: null,
    didDocumentMetadata: { created: state.created },
    didResolutionMetadata: {
      error: 'notYetAvailable',
      message:
        'DID issuance found on chain but document transaction has not propagated yet. Try again shortly.'
    }
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

  constructor(config?: DIDResolverConfig) {
    this.resolverUrl = config?.resolverUrl ?? DEFAULT_RESOLVER_URL
    this.wocBaseUrl = config?.wocBaseUrl ?? DEFAULT_WOC_BASE
    this.resolverTimeout = config?.resolverTimeout ?? 10_000
    this.maxHops = config?.maxHops ?? 100
  }

  async resolve(did: string): Promise<DIDResolutionResult> {
    const txidMatch = /^did:bsv:([0-9a-f]{64})$/i.exec(did)

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
            ...data.didResolutionMetadata
          }
        }
      }

      if (response.status === 410) {
        const data: any = await response.json().catch(() => ({}))
        return {
          didDocument: data.didDocument ?? null,
          didDocumentMetadata: { deactivated: true, ...data.didDocumentMetadata },
          didResolutionMetadata: {
            contentType: 'application/did+ld+json',
            ...data.didResolutionMetadata
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

  private async resolveViaWoC(txid: string): Promise<DIDResolutionResult> {
    let currentTxid = txid
    const visited = new Set<string>()
    const state: WocChainState = {
      lastDocument: null,
      lastDocTxid: undefined,
      created: undefined,
      updated: undefined,
      foundIssuance: false
    }

    for (let hop = 0; hop < this.maxHops; hop++) {
      if (visited.has(currentTxid)) break
      visited.add(currentTxid)

      const txResp = await fetch(`${this.wocBaseUrl}/tx/${currentTxid}`)
      if (!txResp.ok) return notFoundResult()
      const txData: any = await txResp.json()

      state.created ??= txData.time == null ? undefined : new Date(txData.time * 1000).toISOString()

      const segments = extractBsvdidSegments((txData.vout as any[] | null) ?? [])
      const earlyExit = processWocSegments(segments, txData, currentTxid, state)
      if (earlyExit != null) return earlyExit

      let nextTxid = await fetchNextTxidViaSpend(this.wocBaseUrl, currentTxid)
      nextTxid ??= await fetchNextTxidViaHistory(this.wocBaseUrl, txData, visited)
      if (nextTxid == null) break
      currentTxid = nextTxid
    }

    return finalChainResult(state) ?? notFoundResult()
  }
}

// ============================================================================
// Next.js handler factory
// ============================================================================

export function createDIDResolverHandler(
  config?: DIDResolverConfig
): ReturnType<typeof toNextHandlers> {
  const resolver = new DIDResolverService(config)

  const coreHandlers = {
    async GET(req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const did = params.get('did')

      if (did == null || did === '') {
        return jsonResponse({ error: 'Missing "did" query parameter' }, 400)
      }

      try {
        const result = await resolver.resolve(did)
        let status = 200
        if (result.didResolutionMetadata.error === 'notFound') {
          status = 404
        } else if (result.didResolutionMetadata.error === 'internalError') {
          status = 502
        }
        return jsonResponse(result, status)
      } catch (error) {
        return jsonResponse(
          {
            didDocument: null,
            didDocumentMetadata: {},
            didResolutionMetadata: {
              error: 'internalError',
              message: `Resolution failed: ${(error as Error).message}`
            }
          },
          502
        )
      }
    }
  }

  return toNextHandlers(coreHandlers)
}
