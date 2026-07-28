import type { DIDDocumentV2, DIDResolutionResult } from '../core/types'

const DID_CONTENT_TYPE = 'application/did+ld+json'

export interface WocChainState {
  lastDocument: DIDDocumentV2 | null
  lastDocTxid: string | undefined
  created: string | undefined
  updated: string | undefined
  foundIssuance: boolean
}

export function processWocSegments(
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
      state.lastDocument = JSON.parse(payload) as DIDDocumentV2
      state.lastDocTxid = currentTxid
      state.updated = timestamp
    } catch {
      // Not valid JSON
    }
  }
  return null
}
