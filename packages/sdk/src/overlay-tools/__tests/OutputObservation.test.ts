import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseOutputObservation,
  parseOutputProposal,
  parseOutputScope,
  OutputProtocolError,
  type OutputProposalBody
} from '../../../mod.js'

const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/output-wire.json'), 'utf8'))
const proposal = () => parseOutputProposal(structuredClone(fixture.proposal))
const scope = {
  ...parseOutputScope(fixture.live.batch.scope),
  service: proposal().body.service
}
const point = { chain: scope.chain, txid: '01'.repeat(32), outputIndex: 0 }
const channel = {
  service: scope.service,
  policy: proposal().body.policy,
  channel: proposal().body.channel,
  proposalId: '03'.repeat(32)
}
const finalization = { recordedAt: '2', operationId: 'abcdefghijklmnop', txid: point.txid }

describe('BRC-192 proposal and observation representations', () => {
  it('accepts every source assertion separately from a signed proposal', () => {
    const observations = [
      {
        kind: 'output',
        payload: {
          evidence: { txid: point.txid, outputIndex: 0, beef: 'AA==' },
          context: { schema: 'urn:example:private-context:1', bytes: 'AQ==' }
        }
      },
      { kind: 'spend', payload: { previous: point, spendingTxid: '02'.repeat(32), beef: 'AA==' } },
      { kind: 'withdraw', payload: { outpoint: point, reason: 'Provider membership removed' } },
      {
        kind: 'assessment-invalidated',
        payload: { contextId: 'provider-context', reason: 'New source view' }
      },
      { kind: 'proposal', payload: { proposal: proposal() } },
      {
        kind: 'proposal-remove',
        payload: { ...channel, reason: 'Source no longer advertises proposal' }
      }
    ]
    for (const item of observations) {
      const input = { id: item.kind, scope, ...item }
      expect(parseOutputObservation(input)).toEqual(input)
      expect(() => parseOutputObservation({ ...input, authenticatedPeer: 'remote-claim' })).toThrow(
        'Unknown'
      )
    }
  })

  it.each([
    { status: 'active', recordedAt: '1' },
    { status: 'withdrawn', recordedAt: '1' },
    { status: 'expired', recordedAt: '1' },
    { status: 'finalizing', ...finalization },
    {
      status: 'finalization-failed',
      ...finalization,
      reason: 'Local submission outcome unavailable',
      globalOutcome: 'unknown'
    },
    {
      status: 'finalized',
      ...finalization,
      steak: {
        tm_records: {
          outputsToAdmit: [0],
          coinsToRetain: [1],
          coinsRemoved: [2]
        }
      },
      assessmentContextId: 'source-assessment'
    }
  ])('parses the closed $status provider state', state => {
    const input = { id: 'state', scope, kind: 'proposal-state', payload: { ...channel, state } }
    expect(parseOutputObservation(input)).toEqual(input)
    expect(() =>
      parseOutputObservation({
        ...input,
        payload: {
          ...input.payload,
          state: { ...state, unspecified: true }
        }
      })
    ).toThrow('Unknown')
  })

  it('requires finalized admission instructions and treats a failed finalization as globally unknown', () => {
    const input = (state: unknown) => ({
      id: 'state',
      scope,
      kind: 'proposal-state',
      payload: { ...channel, state }
    })
    expect(() =>
      parseOutputObservation(
        input({
          status: 'finalized',
          ...finalization,
          steak: { tm_records: { outputsToAdmit: [0] } },
          assessmentContextId: 'context'
        })
      )
    ).toThrow('coinsToRetain')
    expect(() =>
      parseOutputObservation(
        input({
          status: 'finalization-failed',
          ...finalization,
          reason: 'Local failure',
          globalOutcome: 'rejected'
        })
      )
    ).toThrow('tag')
    expect(() =>
      parseOutputObservation(input({ status: 'unknown-state', recordedAt: '1' }))
    ).toThrow('variant')
  })

  it('binds proposal, lifecycle and removal service names to their attributable scope', () => {
    for (const item of [
      { kind: 'proposal', payload: { proposal: proposal() } },
      {
        kind: 'proposal-state',
        payload: { ...channel, state: { status: 'active', recordedAt: '1' } }
      },
      { kind: 'proposal-remove', payload: { ...channel, reason: 'Removed' } }
    ])
      expect(() =>
        parseOutputObservation({
          id: item.kind,
          scope: { ...scope, service: 'another-service' },
          ...item
        })
      ).toThrow('service mismatch')
  })

  it('rejects cross-chain evidence-bearing observations and proposal anchors', () => {
    const other = { ...scope.chain, network: 'another-network' }
    for (const item of [
      {
        kind: 'spend',
        payload: { previous: { ...point, chain: other }, spendingTxid: point.txid, beef: 'AA==' }
      },
      { kind: 'withdraw', payload: { outpoint: { ...point, chain: other }, reason: 'Removed' } },
      {
        kind: 'proposal',
        payload: { proposal: { ...proposal(), body: { ...proposal().body, chain: other } } }
      }
    ])
      expect(() => parseOutputObservation({ id: item.kind, scope, ...item })).toThrow(
        'chain mismatch'
      )
    const input = proposal()
    input.body.anchors = [{ ...point, chain: other }]
    expect(() => parseOutputProposal(input)).toThrow('anchor chain mismatch')
  })

  it('accepts a later proposal with ordered anchors and explicit supported extensions', () => {
    const input = proposal()
    Object.assign(input.body, {
      revision: '1',
      previous: '04'.repeat(32),
      operation: 'withdraw',
      transaction: 'AA==',
      anchors: [point, { ...point, outputIndex: 1 }, { ...point, txid: '02'.repeat(32) }],
      extensions: { 'urn:example:policy-extension:1': { enabled: true } },
      critical: ['urn:example:policy-extension:1']
    })
    expect(() => parseOutputProposal(input)).toThrow('Unsupported critical')
    expect(parseOutputProposal(input, input.body.critical)).toEqual(input)
    const observation = { id: 'proposal', scope, kind: 'proposal', payload: { proposal: input } }
    expect(parseOutputObservation(observation, input.body.critical)).toEqual(observation)
  })

  it.each<[string, (body: OutputProposalBody) => void]>([
    [
      'empty lifetime',
      body => {
        body.expiresAt = body.issuedAt
      }
    ],
    [
      'reversed lifetime',
      body => {
        body.expiresAt = '0'
      }
    ],
    [
      'missing predecessor',
      body => {
        body.revision = '1'
      }
    ],
    [
      'initial predecessor',
      body => {
        body.previous = '04'.repeat(32)
      }
    ],
    [
      'duplicate recipients',
      body => {
        body.recipients = [body.author, body.author]
      }
    ],
    [
      'unordered recipients',
      body => {
        body.recipients.reverse()
      }
    ],
    [
      'duplicate anchors',
      body => {
        body.anchors = [point, point]
      }
    ],
    [
      'unordered anchors',
      body => {
        body.anchors = [{ ...point, outputIndex: 1 }, point]
      }
    ]
  ])('rejects %s without creating a valid proposal', (_label, change) => {
    const input = proposal()
    change(input.body)
    expect(() => parseOutputProposal(input)).toThrow(OutputProtocolError)
  })
})
