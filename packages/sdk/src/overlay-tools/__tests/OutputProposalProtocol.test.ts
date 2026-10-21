import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseOutputProposal,
  parseOutputProposalPut,
  parseOutputProposalPutResponse,
  parseOutputProposalGet,
  parseOutputProposalGetResponse,
  parseOutputProposalFinalize,
  parseOutputProposalFinalizeResponse,
  type OutputProposalState
} from '../../../mod.js'

const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/output-wire.json'), 'utf8'))
const proposal = () => parseOutputProposal(structuredClone(fixture.proposal))
const proposalId = '01'.repeat(32)
const txid = '02'.repeat(32)
const finalization = { recordedAt: '2', operationId: 'abcdefghijklmnop', txid }
const finalized: OutputProposalState = {
  status: 'finalized',
  ...finalization,
  steak: { tm_records: { outputsToAdmit: [0], coinsToRetain: [] } },
  assessmentContextId: 'admission-context'
}

describe('BRC-194 proposal endpoint representations', () => {
  it('parses put and get without conflating author signature and provider state', () => {
    const signed = proposal(),
      put = { version: 1, proposal: signed }
    expect(parseOutputProposalPut(JSON.stringify(put))).toEqual(put)
    const get = {
      version: 1,
      service: signed.body.service,
      policy: signed.body.policy,
      channel: signed.body.channel
    }
    expect(parseOutputProposalGet(new TextEncoder().encode(JSON.stringify(get)))).toEqual(get)
    const recorded = {
      version: 1,
      proposalId,
      status: 'recorded',
      expiresAt: signed.body.expiresAt
    }
    expect(parseOutputProposalPutResponse(recorded)).toEqual(recorded)
    const returned = { version: 1, proposal: signed, state: { status: 'active', recordedAt: '1' } }
    const parsed = parseOutputProposalGetResponse(returned)
    expect(parsed).toEqual(returned)
    expect(parsed.proposal.signature).toBe(signed.signature)
    returned.proposal.body.service = 'changed-after-parse'
    expect(parsed.proposal.body.service).not.toBe('changed-after-parse')
  })

  it.each<OutputProposalState>([
    { status: 'active', recordedAt: '1' },
    { status: 'withdrawn', recordedAt: '1' },
    { status: 'expired', recordedAt: '1' },
    { status: 'finalizing', ...finalization },
    {
      status: 'finalization-failed',
      ...finalization,
      reason: 'Rejected locally',
      globalOutcome: 'unknown'
    },
    finalized
  ])('retains exact $status fields without treating them as author approvals', state => {
    const get = { version: 1, proposal: proposal(), state }
    expect(parseOutputProposalGetResponse(get)).toEqual(get)
    const result = { version: 1, proposalId, state }
    expect(parseOutputProposalFinalizeResponse(result)).toEqual(result)
    expect(() =>
      parseOutputProposalFinalizeResponse({ ...result, state: { ...state, unrecognized: true } })
    ).toThrow('Unknown')
  })

  it('preserves explicit finalization identifiers and treats BEEF as unverified representation', () => {
    const request = { version: 1, ...finalization, service: 'tm_records', proposalId, beef: 'AA==' }
    const { recordedAt: _time, ...input } = request
    expect(parseOutputProposalFinalize(input)).toEqual(input)
    for (const operationId of ['', 'too-short', 'a'.repeat(129), 'invalid/identifier'])
      expect(() => parseOutputProposalFinalize({ ...input, operationId })).toThrow('request ID')
    expect(() => parseOutputProposalFinalize({ ...input, beef: 'AB==' })).toThrow()
    expect(() =>
      parseOutputProposalFinalize({ ...input, txid: txid.toUpperCase().replace('0', 'A') })
    ).toThrow()
  })

  it('enforces every closed envelope before data reaches a service or wallet', () => {
    const signed = proposal()
    const values: [(input: unknown) => unknown, unknown][] = [
      [parseOutputProposalPut, { version: 1, proposal: signed }],
      [
        parseOutputProposalPutResponse,
        { version: 1, proposalId, status: 'recorded', expiresAt: '2' }
      ],
      [
        parseOutputProposalGet,
        {
          version: 1,
          service: 'tm_records',
          policy: signed.body.policy,
          channel: signed.body.channel
        }
      ],
      [parseOutputProposalGetResponse, { version: 1, proposal: signed, state: finalized }],
      [
        parseOutputProposalFinalize,
        {
          version: 1,
          operationId: finalization.operationId,
          service: 'tm_records',
          proposalId,
          txid,
          beef: 'AA=='
        }
      ],
      [parseOutputProposalFinalizeResponse, { version: 1, proposalId, state: finalized }]
    ]
    for (const [parse, value] of values) {
      expect(() => parse({ ...(value as object), authenticatedPeer: 'sender-claim' })).toThrow(
        'Unknown'
      )
      expect(() => parse({ ...(value as object), version: 2 })).toThrow('tag')
      const { version: _version, ...missing } = value as { version: number }
      expect(() => parse(missing)).toThrow('version')
    }
  })

  it('applies intrinsic proposal checks and critical-extension selection in both directions', () => {
    const signed = proposal()
    signed.body.revision = '1'
    expect(() => parseOutputProposalPut({ version: 1, proposal: signed })).toThrow('predecessor')
    expect(() =>
      parseOutputProposalGetResponse({ version: 1, proposal: signed, state: finalized })
    ).toThrow('predecessor')
    signed.body.previous = proposalId
    signed.body.extensions = { 'urn:example:proposal-policy:1': { supported: true } }
    signed.body.critical = ['urn:example:proposal-policy:1']
    const put = { version: 1, proposal: signed },
      get = { version: 1, proposal: signed, state: finalized }
    expect(() => parseOutputProposalPut(put)).toThrow('Unsupported critical')
    expect(() => parseOutputProposalGetResponse(get)).toThrow('Unsupported critical')
    expect(parseOutputProposalPut(put, signed.body.critical)).toEqual(put)
    expect(parseOutputProposalGetResponse(get, signed.body.critical)).toEqual(get)
  })

  it('rejects duplicate decoded JSON keys and invalid UTF-8 before accepting an endpoint message', () => {
    expect(() => parseOutputProposalGet('{"version":1,"ver\\u0073ion":1}')).toThrow('Duplicate')
    expect(() => parseOutputProposalGet(Uint8Array.from([0xff]))).toThrow()
    expect(() =>
      parseOutputProposalPutResponse({
        version: 1,
        proposalId,
        status: 'recorded',
        expiresAt: '18446744073709551616'
      })
    ).toThrow()
  })
})
