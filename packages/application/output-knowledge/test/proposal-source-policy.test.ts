import { AuthorDocumentPolicy } from '../src/proposals/AuthorDocumentPolicy.js'
import { ProposalPolicyRegistry } from '../src/proposals/ProposalPolicyRegistry.js'
import { knowledgeLocalFrame } from '../src/VerificationLedger.js'
import type { ReceivedSourceGroup } from '../src/SourceMembership.js'
import type { OutputProposalBody } from '@bsv/sdk'
import { describe, expect, it } from '@jest/globals'
import {
  ProposalSourcePolicy,
  parseProposalSourceRules,
  proposalEnvelopeIdentity,
  type ProposalSourceRule
} from '../src/proposals/ProposalSourcePolicy.js'
import {
  author,
  recipient,
  outsider,
  chain,
  scope,
  registry,
  reference,
  signed
} from './proposal-fixture.js'

const source = {
  chain,
  provider: author,
  service: 'ls_private_documents',
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'reader-access',
  epoch: 'first-epoch'
}
function rule(): ProposalSourceRule {
  const { epoch: _epoch, ...selected } = source
  return {
    source: selected,
    proposalService: scope.service,
    policy: { ...reference },
    maxLifetimeSeconds: '90',
    futureSkewSeconds: '2'
  }
}
const install = () => new ProposalSourcePolicy(registry, recipient, [rule()])

describe('installed client proposal source interpretation', () => {
  it('binds the proposal service independently of the selected lookup service and owns installation bytes', () => {
    const selected = rule(),
      policy = new ProposalSourcePolicy(registry, recipient, [selected])
    selected.source.service = 'uninstalled-service'
    selected.policy.digest = 'ff'.repeat(32)
    const proposal = signed()
    expect(policy.validate(proposal, source, '10')).toEqual(proposal)
    const configuration = policy.describe()
    configuration.rules[0].proposalService = 'changed'
    configuration.policies[0].parameters.maxTextBytes = 999
    expect(policy.describe().rules[0].proposalService).toBe(scope.service)
    expect(policy.describe().policies[0].parameters).toEqual({ maxTextBytes: 32 })
    expect(policy.validate(proposal, { ...source, epoch: 'next-epoch' }, '10')).toEqual(proposal)
  })

  it.each(['provider', 'service', 'queryDigest', 'rulesDigest', 'access'] as const)(
    'requires the exact installed source %s',
    field => {
      const changed = {
        ...source,
        [field]: field.endsWith('Digest') ? 'fa'.repeat(32) : 'different-source'
      }
      expect(() => install().validate(signed(), changed, '10')).toThrow('No installed')
    }
  )

  it('retains historical expired heads without calling them currently active', () => {
    const proposal = signed()
    expect(install().validate(proposal, source, '101')).toEqual(proposal)
    expect(install().validate(proposal, source, '8')).toEqual(proposal)
    expect(() => install().validate(signed(), source, '7')).toThrow('clock')
    expect(() => install().validate(signed({ expiresAt: '101' }), source, '10')).toThrow('clock')
  })

  it('requires installed policy read permission and an actual author signature', () => {
    const policy = new ProposalSourcePolicy(registry, outsider, [rule()])
    expect(() => policy.validate(signed(), source, '10')).toThrow('does not permit')
    const proposal = signed()
    proposal.body.payload = 'AQ=='
    expect(() => install().validate(proposal, source, '10')).toThrow()
    expect(() =>
      install().validate(signed({ service: 'different-proposal-service' }), source, '10')
    ).toThrow('selected service')
  })

  it('rejects changed or missing installed policy parameters before source intake', () => {
    const selected = rule()
    selected.policy.digest = 'ff'.repeat(32)
    expect(() => new ProposalSourcePolicy(registry, recipient, [selected])).toThrow('not installed')
    expect(() => new ProposalSourcePolicy(registry, 'not-an-identity', [rule()])).toThrow()
    expect(() => parseProposalSourceRules([])).toThrow('1–64')
    expect(() => parseProposalSourceRules([rule(), rule()])).toThrow('Duplicate')
    expect(() => parseProposalSourceRules([{ ...rule(), extra: true }])).toThrow('Unknown')
  })

  it.each(['0', '-1', '01', '18446744073709551616'])(
    'rejects malformed lifetime %s',
    maxLifetimeSeconds => {
      expect(() => parseProposalSourceRules([{ ...rule(), maxLifetimeSeconds }])).toThrow()
    }
  )

  it('retains the entire signed envelope in local verification identity', () => {
    const proposal = signed(),
      first = proposalEnvelopeIdentity(proposal)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(proposalEnvelopeIdentity(structuredClone(proposal))).toBe(first)
    proposal.signature = 'AQ=='
    expect(proposalEnvelopeIdentity(proposal)).not.toBe(first)
  })
})

it('returns the checked signed envelope independently of the permission callback input', () => {
  const localPolicy = Object.assign(new AuthorDocumentPolicy(), {
    permits(_action: string, body: OutputProposalBody) {
      body.payload = 'AQ=='
      return true
    }
  })
  const installed = new ProposalPolicyRegistry([
    { policy: localPolicy, parameters: { maxTextBytes: 32 } }
  ])
  const sourcePolicy = new ProposalSourcePolicy(installed, recipient, [rule()]),
    proposal = signed()
  expect(sourcePolicy.validate(proposal, source, '10')).toEqual(proposal)
})

it('canonicalizes independently ordered installations and accepts the exact source-count bound', () => {
  const sources = Array.from({ length: 64 }, (_, index) => ({
    ...rule(),
    source: { ...rule().source, access: `reader-${index}` }
  }))
  const ascending = new ProposalSourcePolicy(registry, recipient, sources)
  const descending = new ProposalSourcePolicy(registry, recipient, [...sources].reverse())
  expect(ascending.describe()).toEqual(descending.describe())
  expect(ascending.describe().rules).toHaveLength(64)
  expect(() =>
    parseProposalSourceRules([
      ...sources,
      { ...rule(), source: { ...rule().source, access: 'one-too-many' } }
    ])
  ).toThrow('1–64')
  expect(() =>
    parseProposalSourceRules([{ ...rule(), policy: { ...reference, id: 'not-an-iri' } }])
  ).toThrow('IRI')
  expect(() => parseProposalSourceRules([{ ...rule(), futureSkewSeconds: '-1' }])).toThrow()
})

it('does not use a changed chain or caller-mutated rule description', () => {
  const installed = install(),
    selected = installed.rule(source)!
  selected.source.chain.genesisHash = 'ff'.repeat(32)
  selected.proposalService = 'other'
  expect(installed.rule(source)?.proposalService).toBe(scope.service)
  expect(() =>
    installed.validate(
      signed(),
      { ...source, chain: { ...chain, genesisHash: 'ff'.repeat(32) } },
      '10'
    )
  ).toThrow('No installed')
})

it('keeps separately created journals isolated when they share one installed source policy', () => {
  const selected = rule()
  selected.source.service = selected.proposalService
  const policy = new ProposalSourcePolicy(registry, recipient, [selected]),
    one = policy.createState(4096),
    two = policy.createState(4096),
    bitcoin = knowledgeLocalFrame(false, [], [], 3)
  const row: ReceivedSourceGroup = {
    scope: { ...selected.source, epoch: 'one' },
    generation: '0',
    received: '1',
    phase: 'finite',
    status: 'pending',
    group: {
      id: 'head',
      sequence: '0',
      observations: [
        {
          id: 'signed-head',
          scope: { ...selected.source, epoch: 'one' },
          kind: 'proposal',
          payload: { proposal: signed() }
        }
      ]
    }
  }
  one.apply(one.frame(bitcoin, 'context', [], '9'), 'context', [])
  two.apply(two.frame(bitcoin, 'context', [], '9'), 'context', [])
  const received = one.frame(bitcoin, 'receive', [row], '10')
  one.apply(received, 'receive', [row])
  expect(one.pool.pending()).toHaveLength(1)
  expect(two.pool.pending()).toEqual([])
  expect(two.evaluatedAt).toBe('9')
  const checked = one.pool.verify(one.pool.pending()[0])
  one.apply(one.frame(bitcoin, 'accept', [row], '11', [checked]), 'accept', [row])
  expect(one.evaluatedAt).toBe('11')
  expect(two.evaluatedAt).toBe('9')
  expect(two.pool.pending()).toEqual([])
  expect(() => policy.createState(0)).toThrow('byte bound')
})

it('canonically binds multiple installed policies without accepting another installed selection', () => {
  const original = new AuthorDocumentPolicy()
  const alternate = {
    id: 'urn:test:alternate-document',
    parameters: original.parameters.bind(original),
    validate: original.validate.bind(original),
    permits: original.permits.bind(original),
    successor: original.successor.bind(original),
    finalization: original.finalization.bind(original)
  }
  const installed = new ProposalPolicyRegistry([
    { policy: original, parameters: { maxTextBytes: 32 } },
    { policy: alternate, parameters: { maxTextBytes: 32 } }
  ])
  const { parameters: _parameters, ...secondReference } = installed.describe()[1]
  const rules = [
    rule(),
    { ...rule(), source: { ...rule().source, access: 'other' }, policy: secondReference }
  ]
  const ascending = new ProposalSourcePolicy(installed, recipient, rules),
    descending = new ProposalSourcePolicy(installed, recipient, [...rules].reverse())
  expect(descending.describe()).toEqual(ascending.describe())
  expect(ascending.describe().policies.map(value => value.id)).toEqual([original.id, alternate.id])
  const proposal = signed({ policy: secondReference })
  expect(ascending.validate(proposal, { ...source, access: 'other' }, '10')).toEqual(proposal)
  expect(() => ascending.validate(proposal, source, '10')).toThrow('source policy selection')
})
