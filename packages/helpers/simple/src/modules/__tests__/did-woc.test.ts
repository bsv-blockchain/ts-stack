import { processWocSegments, type WocChainState } from '../did-woc'

const document = {
  '@context': 'https://www.w3.org/ns/did/v1',
  id: 'did:bsv:example',
  verificationMethod: [],
  authentication: []
}

function chainState(): WocChainState {
  return {
    lastDocument: null,
    lastDocTxid: undefined,
    created: '2026-07-28T00:00:00.000Z',
    updated: undefined,
    foundIssuance: false
  }
}

describe('DID WhatsOnChain transitions', () => {
  it('ignores incomplete, funding, and malformed-document segments', () => {
    const state = chainState()

    expect(processWocSegments(['BSVDID', 'identity'], {}, 'incomplete', state)).toBeNull()
    expect(processWocSegments(['BSVDID', 'identity', '2'], {}, 'funding', state)).toBeNull()
    expect(
      processWocSegments(['BSVDID', 'identity', '{invalid'], {}, 'malformed', state)
    ).toBeNull()
    expect(state).toEqual(chainState())
  })

  it('records issuance and valid document transitions', () => {
    const state = chainState()

    expect(processWocSegments(['BSVDID', 'identity', '1'], {}, 'issuance', state)).toBeNull()
    expect(state.foundIssuance).toBe(true)

    expect(
      processWocSegments(
        ['BSVDID', 'identity', JSON.stringify(document)],
        { time: 1_753_660_800 },
        'document',
        state
      )
    ).toBeNull()
    expect(state).toEqual({
      lastDocument: document,
      lastDocTxid: 'document',
      created: '2026-07-28T00:00:00.000Z',
      updated: '2025-07-28T00:00:00.000Z',
      foundIssuance: true
    })
  })

  it('returns the last document when the chain is deactivated', () => {
    const state = chainState()
    state.lastDocument = document
    state.updated = '2026-07-28T01:00:00.000Z'

    expect(processWocSegments(['BSVDID', 'identity', '3'], {}, 'revocation', state)).toEqual({
      didDocument: state.lastDocument,
      didDocumentMetadata: {
        created: state.created,
        updated: state.updated,
        deactivated: true,
        versionId: 'revocation'
      },
      didResolutionMetadata: { contentType: 'application/did+ld+json' }
    })
  })
})
