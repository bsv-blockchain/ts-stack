import { afterEach, expect, it, jest } from '@jest/globals'
import { PublicKey } from '@bsv/sdk'
import { ProposalPolicyRegistry } from '../src/proposals/ProposalPolicyRegistry.js'
import { AuthorDocumentPolicy } from '../src/proposals/AuthorDocumentPolicy.js'
import {
  author,
  recipient,
  scope,
  signed,
  bytes,
  createRegistry
} from './proposal-client-fixture.js'

afterEach(() => {
  jest.restoreAllMocks()
})

it('reuses only the exact successful author-signature result', () => {
  const proposal = signed(),
    registry = createRegistry()
  const verify = jest.spyOn(PublicKey.prototype, 'verify')
  registry.validate(proposal, scope)
  expect(verify).toHaveBeenCalledTimes(1)
  registry.validate(structuredClone(proposal), scope)
  expect(verify).toHaveBeenCalledTimes(1)
  const changed = structuredClone(proposal)
  changed.body.payload = bytes('{"text":"changed"}')
  expect(() => registry.validate(changed, scope)).toThrow('author signature')
  expect(() => registry.validate(changed, scope)).toThrow('author signature')
  expect(verify).toHaveBeenCalledTimes(3)
  registry.validate(proposal, scope).body.payload = changed.body.payload
  expect(registry.validate(proposal, scope)).toEqual(proposal)
  expect(verify).toHaveBeenCalledTimes(3)
})

it('verifies a distinct valid signature for the same body before caching its exact bytes', () => {
  const first = signed(),
    second = signed(),
    registry = createRegistry()
  expect(first.body).toEqual(second.body)
  expect(first.signature).not.toBe(second.signature)
  const verify = jest.spyOn(PublicKey.prototype, 'verify')
  registry.validate(first, scope)
  registry.validate(second, scope)
  expect(verify).toHaveBeenCalledTimes(2)
  registry.validate(first, scope)
  registry.validate(second, scope)
  expect(verify).toHaveBeenCalledTimes(2)
})

it('does not share positive results across registries', () => {
  const proposal = signed(),
    left = createRegistry(),
    right = createRegistry()
  const verify = jest.spyOn(PublicKey.prototype, 'verify')
  left.validate(proposal, scope)
  right.validate(proposal, scope)
  expect(verify).toHaveBeenCalledTimes(2)
})

it('continues checking current policy and scope on a cached signature', () => {
  const policy = new AuthorDocumentPolicy()
  const registry = new ProposalPolicyRegistry([{ policy, parameters: { maxTextBytes: 32 } }])
  const proposal = signed()
  registry.validate(proposal, scope)
  expect(() => registry.validate(proposal, { ...scope, service: 'other' })).toThrow(
    'selected service'
  )
  const validate = jest.spyOn(policy, 'validate').mockImplementation(() => {
    throw new Error('current policy rejects')
  })
  expect(() => registry.validate(proposal, scope)).toThrow('current policy rejects')
  validate.mockRestore()
  const permits = jest.spyOn(policy, 'permits').mockReturnValue(false)
  expect(() => registry.authorize('read', proposal, scope, author)).toThrow('permit this caller')
  expect(registry.permits('read', proposal, recipient)).toBe(false)
  permits.mockRestore()
  expect(registry.permits('read', proposal, recipient)).toBe(true)
})

it('rechecks different signature bytes and never accepts a modified signer or body', () => {
  const registry = createRegistry(),
    proposal = signed()
  registry.validate(proposal, scope)
  for (const changed of [
    { ...proposal, signature: signed().signature },
    { ...proposal, signature: '' },
    { ...proposal, body: { ...proposal.body, author: recipient } },
    { ...proposal, body: { ...proposal.body, service: 'other' } }
  ]) {
    // A separately signed identical body can be valid; change its message before checking it.
    const altered = { ...changed, body: { ...changed.body, payload: bytes('{"text":"tampered"}') } }
    expect(() => registry.validate(altered, scope)).toThrow()
  }
})

it('bounds cached identities and re-verifies an evicted signed envelope', () => {
  const registry = createRegistry()
  const proposals = Array.from({ length: 257 }, (_, index) =>
    signed({ channel: index.toString(16).padStart(64, '0') })
  )
  const verify = jest.spyOn(PublicKey.prototype, 'verify')
  for (let index = 0; index < 256; index++) registry.validate(proposals[index], scope)
  registry.validate(proposals[0], scope)
  expect(verify).toHaveBeenCalledTimes(256)
  registry.validate(proposals[256], scope)
  registry.validate(proposals[1], scope)
  expect(verify).toHaveBeenCalledTimes(257)
  registry.validate(proposals[0], scope)
  expect(verify).toHaveBeenCalledTimes(258)
})
