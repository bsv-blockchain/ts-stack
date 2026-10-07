import { describe, expect, it } from '@jest/globals'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  outputPacketDigest,
  type OutputChain,
  type OutputJSON,
  type OutputJSONObject,
  type OutputProposalState,
  type OutputSignedProposal
} from '@bsv/sdk'
import { AuthorDocumentPolicy } from '../src/proposals/AuthorDocumentPolicy.js'
import { ProposalPolicyRegistry } from '../src/proposals/ProposalPolicyRegistry.js'
import {
  ProposalChannelHeadsQuery,
  proposalChannelIndexKey
} from '../src/proposals/ProposalChannelHeadsQuery.js'
import { ProposalChannelHeadsContract } from '../src/proposals/ProposalChannelHeadsContract.js'
import { SQLiteLookupIndex } from '../src/lookup/SQLiteLookupIndex.js'
import { SQLiteLookupSessions } from '../src/lookup/SQLiteLookupSessions.js'
import type { LookupIndexRow } from '../src/lookup/LookupIndexCodec.js'
import type {
  LookupObservationTemplate,
  LookupQueryContext
} from '../src/lookup/LookupQueryPolicy.js'
import { lookupSessionFixture } from './lookup-session-fixture.js'

interface ModelRow {
  head: string
  state: OutputProposalState
  readable: boolean
}
interface Case {
  name: string
  principal?: string | null
  query?: OutputJSONObject
  rows?: ModelRow[]
  changes?: { before: ModelRow | null; after: ModelRow | null }[]
  expected?: { kind: string; head: string; state?: OutputProposalState }[][]
  error?: string
}
interface Corpus {
  service: string
  chain: OutputChain
  principal: string
  rules: { id: string; parameters: { policy: { id: string; digest: string } } }
  rulesDigest: string
  queries: { query: OutputJSONObject; digest: string }[]
  heads: Record<string, OutputSignedProposal>
  cases: Case[]
}
const raw = readFileSync(new URL('./fixtures/brc295/proposal-query-vectors.json', import.meta.url))
const corpus = JSON.parse(raw.toString()) as Corpus

function installation() {
  const registry = new ProposalPolicyRegistry([
    { policy: new AuthorDocumentPolicy(), parameters: { maxTextBytes: 4096 } }
  ])
  const rule = new ProposalChannelHeadsQuery(registry)
  const parameters = rule.parameters(corpus.rules.parameters)
  return { registry, rule, parameters }
}
function row(value: ModelRow, revision: string): LookupIndexRow {
  const proposal = corpus.heads[value.head]
  return {
    key: proposalChannelIndexKey(proposal),
    revision,
    value: { data: { version: 1, proposal, state: value.state }, expiresAt: null }
  }
}
function labels(observations: LookupObservationTemplate[]) {
  return observations.map(observation => {
    if (observation.kind === 'proposal') {
      const id = outputPacketDigest('proposal', observation.payload.proposal.body)
      return { kind: observation.kind, head: headName(id) }
    }
    if (observation.kind === 'proposal-state')
      return {
        kind: observation.kind,
        head: headName(observation.payload.proposalId),
        state: observation.payload.state
      }
    if (observation.kind === 'proposal-remove')
      return { kind: observation.kind, head: headName(observation.payload.proposalId) }
    throw new Error('Unexpected observation in the frozen proposal query')
  })
}
function headName(id: string): string {
  const name = Object.keys(corpus.heads).find(
    name => outputPacketDigest('proposal', corpus.heads[name].body) === id
  )
  if (name === undefined) throw new Error('Query returned a head outside the frozen corpus')
  return name
}

describe('immutable PR295 proposal-channel corpus', () => {
  it('pins the upstream bytes, three authentic heads and all four frozen selection digests', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      '37cad8b795f1a398c4f52789f0a50d77702814f22bafeb11aaffdcd37cd08294'
    )
    const { registry } = installation()
    expect(registry.describe()[0].digest).toBe(corpus.rules.parameters.policy.digest)
    expect(outputPacketDigest('service-rules', corpus.rules)).toBe(corpus.rulesDigest)
    for (const item of corpus.queries)
      expect(
        outputPacketDigest('lookup-query', { service: corpus.service, query: item.query })
      ).toBe(item.digest)
    for (const proposal of Object.values(corpus.heads))
      expect(registry.validate(proposal, { chain: corpus.chain, service: corpus.service })).toEqual(
        proposal
      )
    registry.successor(corpus.heads.a0, corpus.heads.a1)
    expect(corpus.cases).toHaveLength(16)
  })

  /**
   * The corpus supplies host-readable rows as controlled access-policy inputs.
   * The actual query maps their signed heads; the actual durable session guard
   * enforces resets. This binding does not qualify a provider's access-policy
   * writer or physical enqueue: proposal-current-native and host HTTP tests do.
   */
  it.each(corpus.cases)('$name', async test => {
    const { rule, parameters } = installation()
    const query = rule.query(test.query ?? {}, parameters) as OutputJSONObject
    const principal = Object.hasOwn(test, 'principal') ? test.principal! : corpus.principal
    const context: LookupQueryContext = {
      principal,
      parameters,
      query,
      scope: {
        chain: corpus.chain,
        provider: corpus.principal,
        service: corpus.service,
        rulesDigest: corpus.rulesDigest,
        queryDigest: outputPacketDigest('lookup-query', { service: corpus.service, query }),
        access: 'reader',
        epoch: 'current-corpus'
      }
    }
    const directory = mkdtempSync(join(tmpdir(), 'brc295-query-'))
    const index = SQLiteLookupIndex.create(join(directory, 'lookup.sqlite'), 'corpus', {
      source: 'brc295'
    })
    const fixture = lookupSessionFixture('brc103', '03'.repeat(32), '0')
    const sessions = SQLiteLookupSessions.create(index, fixture.codec, () => '1000')
    try {
      const epoch = await sessions.createEpoch()
      const opening = lookupSessionFixture('brc103', epoch, '0').value
      await sessions.initializeGuard('serving')
      await expect(sessions.commit(opening)).rejects.toMatchObject({ code: 'unavailable' })
      // A captured opening can only commit after all index timers through its
      // evaluation time are processed, even for an otherwise empty index.
      expect(await index.advanceTime(opening.time, 1)).toMatchObject({
        complete: true,
        expired: 0,
        head: { processedThrough: opening.time, sequence: '0' }
      })
      await sessions.commit(opening)
      const execute = async () => {
        if (principal === null) {
          // Refuse before inspecting even an empty snapshot, using the real
          // authenticated-opening codec rather than a fixture exception.
          fixture.codec.normalize({ ...opening, principal: null })
        }
        if (test.rows !== undefined) {
          return test.rows
            .filter(value => value.readable)
            .map(value => row(value, '1'))
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .map(value => rule.snapshot(value, context))
            .filter(value => value.length > 0)
        }
        const changes = test.changes!.map(change => {
          const before = change.before && row(change.before, '1')
          const after = change.after && row(change.after, '2')
          return { change, before, after }
        })
        for (const { change, before, after } of changes) {
          const oldVisible = Boolean(
            before && change.before!.readable && rule.snapshot(before, context).length
          )
          const newVisible = Boolean(
            after && change.after!.readable && rule.snapshot(after, context).length
          )
          if (before && after && oldVisible !== newVisible) {
            await sessions.advanceGuard('serving', '0')
            // Both narrowed and widened captured access fail through the same
            // real durable gate before the old identifier can be serialized.
            await sessions.serialize(
              opening.session,
              {
                principal: opening.principal,
                access: opening.access,
                guards: opening.guards
              },
              opening.first
            )
          }
        }
        const observations = rule.transition(
          {
            sequence: '2',
            recordedAt: '1790611200',
            event: {},
            changes: changes.map(({ change, before, after }) => ({
              key: (after ?? before)!.key,
              before: change.before?.readable ? before : null,
              after: change.after?.readable ? after : null
            }))
          },
          context
        )
        return observations.length ? [observations] : []
      }
      if (test.error !== undefined)
        await expect(execute()).rejects.toMatchObject({ code: test.error })
      else {
        const groups = await execute()
        expect(groups.map(labels)).toEqual(test.expected)
        const contract = new ProposalChannelHeadsContract(
          installation().registry,
          context.scope,
          parameters,
          query
        )
        for (const [position, observations] of groups.entries()) {
          const group = {
            id: String(position),
            sequence: test.rows === undefined ? '2' : '1',
            observations: observations.map((observation, index) => ({
              ...observation,
              id: String(index),
              scope: context.scope
            }))
          }
          expect(
            contract.check(group, test.rows === undefined ? 'live' : 'snapshot').length
          ).toBeGreaterThan(0)
        }
      }
    } finally {
      await index.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses the independent invalid queries and accepts the exact maximum channel list', () => {
    const { rule, parameters } = installation()
    const a = '11'.repeat(32),
      b = '22'.repeat(32)
    const invalid: OutputJSON[] = [
      null,
      [],
      { extra: true },
      { channels: [] },
      { channels: [a, a] },
      { channels: [b, a] },
      { channels: ['FF'.repeat(32)] },
      { channels: [false] },
      { channels: null },
      { channels: Array.from({ length: 257 }, (_, n) => n.toString(16).padStart(64, '0')) }
    ]
    for (const value of invalid) expect(() => rule.query(value, parameters)).toThrow()
    const maximum = {
      channels: Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(64, '0'))
    }
    expect(rule.query(maximum, parameters)).toEqual(maximum)
  })
})
