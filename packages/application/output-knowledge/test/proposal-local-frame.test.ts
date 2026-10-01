import { describe, expect, it } from '@jest/globals'
import { knowledgeLocalFrame, parseKnowledgeLocalFrame } from '../src/VerificationLedger.js'
import { proposalLocalFrame, parseProposalLocalFrame } from '../src/proposals/ProposalLocalFrame.js'
import { ProposalSourcePolicy } from '../src/proposals/ProposalSourcePolicy.js'
import { author, recipient, registry, reference, chain, scope } from './proposal-fixture.js'
const source = {
  chain,
  provider: author,
  service: 'ls_documents',
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'reader'
}
function policy(reader = recipient) {
  return new ProposalSourcePolicy(registry, reader, [
    {
      source,
      proposalService: scope.service,
      policy: reference,
      maxLifetimeSeconds: '90',
      futureSkewSeconds: '2'
    }
  ])
}
const bitcoin = () => knowledgeLocalFrame(false, [], [], 3)
const stamp = () => ({
  reference: { group: 'local-group', observationId: 'head', envelope: '01'.repeat(32) },
  firstReceivedAt: '10'
})

describe('opt-in composite proposal local replay namespace', () => {
  it('round-trips exact canonical Bitcoin bytes and owned proposal installation and work', () => {
    const selected = policy(),
      first = stamp()
    const value = proposalLocalFrame(
      bitcoin(),
      selected,
      '11',
      [first],
      [{ ...first, status: 'verified' }]
    )
    const parsed = parseProposalLocalFrame(value, selected)
    expect(parsed.bitcoin).toEqual(bitcoin())
    expect(parsed.proposals).toEqual({
      configuration: selected.describe(),
      evaluatedAt: '11',
      receipts: [first],
      work: [{ ...first, status: 'verified' }]
    })
    first.firstReceivedAt = '90'
    parsed.proposals.configuration.reader = author
    expect(parseProposalLocalFrame(value, selected).proposals.receipts[0].firstReceivedAt).toBe(
      '10'
    )
    expect(parseProposalLocalFrame(value, selected).proposals.configuration.reader).toBe(recipient)
  })
  it.each([1, 2, 3] as const)(
    'does not accept or silently reinterpret an old version %s namespace',
    version => {
      expect(() =>
        parseProposalLocalFrame(knowledgeLocalFrame(false, [], [], version), policy())
      ).toThrow()
      const value = proposalLocalFrame(bitcoin(), policy(), '11')
      expect(() => parseKnowledgeLocalFrame(value)).toThrow()
      if (version !== 3)
        expect(() =>
          proposalLocalFrame(knowledgeLocalFrame(false, [], [], version), policy(), '11')
        ).toThrow('canonical Bitcoin')
    }
  )
  it('rejects changed reader and source configuration even when the policy identifier is unchanged', () => {
    const value = proposalLocalFrame(bitcoin(), policy(), '11')
    expect(() => parseProposalLocalFrame(value, policy(author))).toThrow('installation changed')
    const altered = structuredClone(value)
    const raw = altered.proposals as Record<string, unknown>
    raw.configuration = { ...policy().describe(), rules: [] }
    expect(() => parseProposalLocalFrame(altered, policy())).toThrow('installation changed')
  })
  it.each(['-1', '01', '18446744073709551616'])('rejects invalid evaluation time %s', now => {
    expect(() => proposalLocalFrame(bitcoin(), policy(), now)).toThrow()
  })
  it('rejects duplicate and foreign fields rather than accepting ambiguous retained work', () => {
    const first = stamp()
    expect(() => proposalLocalFrame(bitcoin(), policy(), '11', [first, first])).toThrow('Duplicate')
    expect(() =>
      proposalLocalFrame(
        bitcoin(),
        policy(),
        '11',
        [],
        [
          { ...first, status: 'verified' },
          { ...first, status: 'invalid' }
        ]
      )
    ).toThrow('Duplicate')
    const value = proposalLocalFrame(bitcoin(), policy(), '11')
    value.extra = true
    expect(() => parseProposalLocalFrame(value, policy())).toThrow('Unknown')
  })
})

it('rejects malformed, oversized and unsupported retained proposal decisions', () => {
  const base = proposalLocalFrame(bitcoin(), policy(), '11')
  const alter = (key: string, value: unknown) => {
    const changed = structuredClone(base)
    const proposals = changed.proposals as Record<string, unknown>
    proposals[key] = value
    return () => parseProposalLocalFrame(changed, policy())
  }
  expect(alter('receipts', {})).toThrow('bound')
  expect(alter('receipts', Array.from({ length: 4097 }, stamp))).toThrow(/limit|bound/)
  expect(alter('work', [{ ...stamp(), status: 'mined' }])).toThrow('decision')
  expect(alter('receipts', [{ ...stamp(), firstReceivedAt: '-1' }])).toThrow()
  expect(
    alter('receipts', [{ ...stamp(), reference: { ...stamp().reference, group: '' } }])
  ).toThrow('group reference')
  expect(
    alter('receipts', [
      { ...stamp(), reference: { ...stamp().reference, group: 'a'.repeat(16385) } }
    ])
  ).toThrow('group reference')
  expect(alter('work', [{ ...stamp(), status: 'verified', extra: true }])).toThrow('Unknown')
  const unsupported = structuredClone(base)
  unsupported.version = 5
  expect(() => parseProposalLocalFrame(unsupported, policy())).toThrow('namespace')
})
