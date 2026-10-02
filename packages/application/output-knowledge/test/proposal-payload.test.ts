import { beforeEach, describe, expect, it } from '@jest/globals'
import { canonicalOutputJSON, type OutputJSONObject } from '@bsv/sdk'
import {
  proposalPayload,
  parseProposalPayload,
  validateProposalLocalContext
} from '../src/proposals/ProposalJournalPayload.js'
import { ProposalTransitions, proposalCommitKey } from '../src/proposals/index.js'
import { author, createRegistry, scope, signed } from './proposal-fixture.js'

let lifecycle: ProposalTransitions
let plan: ReturnType<ProposalTransitions['put']>
beforeEach(() => {
  lifecycle = new ProposalTransitions(createRegistry(), scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  plan = lifecycle.put(undefined, signed(), author, '10')
})
const local = { profile: 'urn:test:proposal-context:1', version: 1 }

describe('versioned proposal local context storage', () => {
  it('preserves the original body-only encoding and commit digest', () => {
    const legacy = proposalPayload(plan, 4194304)
    expect(legacy.text).toBe(canonicalOutputJSON(plan))
    expect(legacy.key).toBe(proposalCommitKey(plan))
    expect(parseProposalPayload(legacy.text, 4194304)).toEqual({ transition: plan })
    const contextual = proposalPayload(plan, 4194304, local)
    expect(contextual.key).toBe(legacy.key)
    expect(contextual.bytes).toBe(new TextEncoder().encode(contextual.text).length)
    expect(contextual.bytes).toBeGreaterThan(legacy.bytes)
    expect(parseProposalPayload(contextual.text, 4194304)).toEqual({
      transition: plan,
      local,
      localDigest: contextual.localDigest
    })
    expect(() => proposalPayload(plan, contextual.bytes - 1, local)).toThrow('limit')
    validateProposalLocalContext(local, contextual.localDigest)
    validateProposalLocalContext(undefined, undefined)
    expect(() => validateProposalLocalContext(undefined, contextual.localDigest)).toThrow(
      'integrity'
    )
    expect(() => validateProposalLocalContext(local, undefined)).toThrow('integrity')
  })

  it('fails closed for unknown, incomplete, malformed or altered frames', () => {
    const frame = JSON.parse(proposalPayload(plan, 4194304, local).text)
    for (const invalid of [
      null,
      1,
      [],
      { ...frame, storageFormat: 'output-proposal-entry/2' },
      { ...frame, local: [] },
      { ...frame, local: null },
      { ...frame, local: 1 },
      { ...frame, local: { ...local, version: 2 } },
      { ...frame, extra: true }
    ])
      expect(() => parseProposalPayload(canonicalOutputJSON(invalid), 4194304)).toThrow()
    const { localDigest: _digest, ...incomplete } = frame
    expect(() => parseProposalPayload(canonicalOutputJSON(incomplete), 4194304)).toThrow('Missing')
    expect(() => proposalPayload(plan, 4194304, [] as unknown as OutputJSONObject)).toThrow(
      'local context'
    )
  })
})
