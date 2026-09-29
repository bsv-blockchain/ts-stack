import { describe, expect, it } from '@jest/globals'
import {
  canonicalOutputJSON,
  LockingScript,
  outputPacketDigest,
  PrivateKey,
  signOutputPacket,
  Transaction,
  Utils
} from '@bsv/sdk'
import {
  AuthorDocumentPolicy,
  ProposalPolicyRegistry,
  proposalChannelKey,
  validateProposalWindow,
  type ProposalPolicy
} from '../src/proposals/index.js'

import {
  author,
  recipient,
  outsider,
  chain,
  scope,
  policy,
  registry,
  reference,
  bytes,
  signed,
  finalize,
  checkFinalization
} from './proposal-fixture.js'

describe('installed BRC-194 proposal policies', () => {
  it('selects exact installed parameters and validates an owned, author-signed envelope', () => {
    const input = signed()
    const validated = registry.validate(input, scope)
    expect(validated).toEqual(input)
    input.body.payload = bytes('{"text":"changed"}')
    expect(validated.body.payload).not.toBe(input.body.payload)
    const description = registry.describe()[0]
    expect(description.digest).toBe(
      outputPacketDigest('proposal-policy', { id: policy.id, parameters: { maxTextBytes: 32 } })
    )
    description.parameters.maxTextBytes = 100
    expect(registry.describe()[0].parameters).toEqual({ maxTextBytes: 32 })
    expect(() =>
      registry.validate(signed({ policy: { ...reference, digest: 'ff'.repeat(32) } }), scope)
    ).toThrow('not installed')
    expect(() =>
      registry.validate(signed({ policy: { ...reference, id: 'urn:uninstalled:1' } }), scope)
    ).toThrow('not installed')
    expect(() => registry.validate(signed({ service: 'different' }), scope)).toThrow(
      'selected service'
    )
    expect(() =>
      registry.validate(signed({ chain: { ...chain, genesisHash: '04'.repeat(32) } }), scope)
    ).toThrow('selected service')
  })

  it('requires the actual author signature, not a caller claim or modified signed payload', () => {
    const proposal = signed()
    proposal.body.payload = bytes('{"text":"altered"}')
    expect(() => registry.validate(proposal, scope)).toThrow('author signature')
    expect(() => registry.validate(signed({ author: recipient }), scope)).toThrow('signer')
    expect(() => registry.validate({ ...signed(), signature: '' }, scope)).toThrow()
  })

  it('bounds installation and rejects duplicate or mutable-version policy selection', () => {
    expect(() => new ProposalPolicyRegistry([])).toThrow('1–32')
    expect(
      () =>
        new ProposalPolicyRegistry(Array.from({ length: 33 }, () => ({ policy, parameters: {} })))
    ).toThrow('1–32')
    expect(
      () =>
        new ProposalPolicyRegistry([
          { policy, parameters: { maxTextBytes: 1 } },
          { policy, parameters: { maxTextBytes: 2 } }
        ])
    ).toThrow('duplicate')
    for (const maximum of [0, 4097, 1.5])
      expect(() => policy.parameters({ maxTextBytes: maximum })).toThrow()
    expect(policy.parameters({ maxTextBytes: 4096 })).toEqual({ maxTextBytes: 4096 })
    expect(() => policy.parameters({ maxTextBytes: 1, other: true })).toThrow('Unknown')
    const invalid = Object.assign(new AuthorDocumentPolicy(), { id: 'not-an-iri' })
    expect(
      () => new ProposalPolicyRegistry([{ policy: invalid, parameters: { maxTextBytes: 1 } }])
    ).toThrow('Invalid')
  })

  it('does not transfer support for a critical extension from a different installed policy', () => {
    const extended: ProposalPolicy = Object.assign(new AuthorDocumentPolicy(), {
      id: 'urn:example:extended-document:1',
      supportedExtensions: ['urn:example:extension:1']
    })
    const selected = new ProposalPolicyRegistry([
      { policy, parameters: { maxTextBytes: 32 } },
      { policy: extended, parameters: { maxTextBytes: 32 } }
    ])
    const proposal = signed({
      extensions: { 'urn:example:extension:1': true },
      critical: ['urn:example:extension:1']
    })
    expect(() => selected.validate(proposal, scope)).toThrow('Unsupported critical')
    const { parameters: _config, ...extendedReference } = selected.describe()[1]
    expect(
      selected.validate(signed({ ...proposal.body, policy: extendedReference }), scope).body.policy
    ).toEqual(extendedReference)
  })

  it('uses exact, exclusive expiry and a finite future-clock and lifetime policy', () => {
    const limits = { maxLifetimeSeconds: '90', futureSkewSeconds: '2' }
    const body = signed().body
    expect(() => validateProposalWindow(body, '8', limits)).not.toThrow()
    expect(() => validateProposalWindow(body, '99', limits)).not.toThrow()
    expect(() => validateProposalWindow(body, '100', limits)).toThrow('expired')
    expect(() => validateProposalWindow(body, '7', limits)).toThrow('clock')
    expect(() =>
      validateProposalWindow(body, '10', { ...limits, maxLifetimeSeconds: '89' })
    ).toThrow('clock')
    expect(() =>
      validateProposalWindow(body, '10', { ...limits, maxLifetimeSeconds: '0' })
    ).toThrow('clock')
    expect(() => validateProposalWindow({ ...body, expiresAt: '10' }, '10', limits)).toThrow(
      'clock'
    )
    expect(() =>
      validateProposalWindow(
        { ...body, issuedAt: '18446744073709551614', expiresAt: '18446744073709551615' },
        '18446744073709551613',
        limits
      )
    ).not.toThrow()
  })

  it('compares the full channel namespace and exact signed predecessor', () => {
    const first = signed()
    const next = signed({
      revision: '1',
      previous: outputPacketDigest('proposal', first.body),
      payload: bytes('{"text":"next"}')
    })
    expect(() => registry.successor(first, next)).not.toThrow()
    for (const change of [
      { channel: 'ff'.repeat(32) },
      { revision: '2' },
      { previous: 'ff'.repeat(32) }
    ])
      expect(() => registry.successor(first, signed({ ...next.body, ...change }))).toThrow(
        'active signed head'
      )
    const withdrawn = signed({ ...next.body, operation: 'withdraw' })
    expect(() => registry.successor(first, withdrawn)).not.toThrow()
    expect(() =>
      registry.successor(
        withdrawn,
        signed({ revision: '2', previous: outputPacketDigest('proposal', withdrawn.body) })
      )
    ).toThrow('active signed head')
    expect(proposalChannelKey(first.body)).toBe(proposalChannelKey(next.body))
    for (const change of [
      { chain: { ...chain, network: 'other' } },
      { service: 'other' },
      { policy: { ...reference, digest: 'ff'.repeat(32) } },
      { channel: 'ff'.repeat(32) }
    ])
      expect(proposalChannelKey({ ...first.body, ...change })).not.toBe(
        proposalChannelKey(first.body)
      )
  })
})

describe('author-document-v1', () => {
  it('allows canonical empty and Unicode text within exact UTF-8 limits', () => {
    for (const text of ['', 'a'.repeat(32), '😀'.repeat(8), '\0'.repeat(32)])
      expect(() =>
        registry.validate(signed({ payload: bytes(canonicalOutputJSON({ text })) }), scope)
      ).not.toThrow()
    for (const text of ['a'.repeat(33), '😀'.repeat(9)])
      expect(() =>
        registry.validate(signed({ payload: bytes(canonicalOutputJSON({ text })) }), scope)
      ).toThrow('installed limit')
  })

  it('rejects alternate JSON, extra fields, duplicate keys, invalid UTF-8 and embedded transactions', () => {
    for (const text of [
      '{ "text":"x"}',
      '{"text":"\\u0078"}',
      '{"text":"x","other":1}',
      '{"text":"a","text":"b"}',
      '{"text":1}',
      '{}'
    ])
      expect(() => registry.validate(signed({ payload: bytes(text) }), scope)).toThrow()
    expect(() => registry.validate(signed({ payload: '/w==' }), scope)).toThrow()
    expect(() => registry.validate(signed({ payload: bytes(' '.repeat(204)) }), scope)).toThrow(
      'limit'
    )
    expect(() => registry.validate(signed({ transaction: '' }), scope)).toThrow('cannot contain')
  })

  it('requires author membership, 1–32 sorted recipients and zero or one chain-bound anchor', () => {
    const anchor = { chain, txid: '03'.repeat(32), outputIndex: 2 }
    expect(() => registry.validate(signed({ anchors: [anchor] }), scope)).not.toThrow()
    for (const recipients of [
      [],
      [recipient],
      [author, author],
      [author, recipient].sort().reverse()
    ])
      expect(() => registry.validate(signed({ recipients }), scope)).toThrow()
    const recipients = Array.from({ length: 33 }, (_, i) =>
      new PrivateKey(i + 1).toPublicKey().toString()
    ).sort()
    expect(() => registry.validate(signed({ recipients }), scope)).toThrow('1–32')
    expect(() =>
      registry.validate(signed({ recipients: recipients.slice(0, 32) }), scope)
    ).not.toThrow()
    expect(() =>
      registry.validate(signed({ anchors: [anchor, { ...anchor, outputIndex: 3 }] }), scope)
    ).toThrow('one anchor')
    expect(() =>
      registry.validate(
        signed({ anchors: [{ ...anchor, chain: { ...chain, network: 'other' } }] }),
        scope
      )
    ).toThrow('chain mismatch')
  })

  it('requires the author for put/finalize and a current recipient for reads, before host access checks', () => {
    const proposal = signed()
    for (const action of ['put', 'finalize'] as const) {
      expect(registry.permits(action, proposal, author)).toBe(true)
      expect(registry.permits(action, proposal, recipient)).toBe(false)
      expect(registry.permits(action, proposal, outsider)).toBe(false)
    }
    expect(registry.permits('read', proposal, author)).toBe(true)
    expect(registry.permits('read', proposal, recipient)).toBe(true)
    expect(registry.permits('read', proposal, outsider)).toBe(false)
    expect(() => registry.permits('read', proposal, 'unauthenticated')).toThrow('identity')
  })

  it('keeps author, recipients and anchors invariant across signed revisions', () => {
    const first = signed()
    const next = { revision: '1', previous: outputPacketDigest('proposal', first.body) }
    expect(() => registry.successor(first, signed({ ...next, recipients: [author] }))).toThrow(
      'retain author'
    )
    expect(() =>
      registry.successor(
        first,
        signed({ ...next, anchors: [{ chain, txid: '03'.repeat(32), outputIndex: 2 }] })
      )
    ).toThrow('retain author')
    const nextAuthor = signOutputPacket(
      'proposal',
      { ...first.body, ...next, author: recipient },
      new PrivateKey(2)
    )
    expect(() => registry.successor(first, nextAuthor)).toThrow('retain author')
  })

  it('requires exact PRP1 bytes and amount at output zero without adding unrelated finality restrictions', () => {
    const proposal = signed()
    const transaction = finalize(proposal)
    expect(transaction.lockTime).toBe(42)
    expect(() => checkFinalization(proposal, transaction)).not.toThrow()
    const mutate = (change: (tx: Transaction) => void) => {
      const tx = finalize(proposal)
      change(tx)
      expect(() => checkFinalization(proposal, tx)).toThrow('exact one-satoshi')
    }
    mutate(tx => {
      tx.outputs = []
    })
    mutate(tx => {
      tx.outputs[0].satoshis = 2
    })
    mutate(tx => {
      tx.outputs.unshift({ satoshis: 1, lockingScript: new LockingScript() })
    })
    mutate(tx => {
      tx.outputs[0].lockingScript = LockingScript.fromHex(
        '006a4c045052503120' + outputPacketDigest('proposal', proposal.body)
      )
    })
    mutate(tx => {
      tx.outputs[0].lockingScript = LockingScript.fromHex('006a045052503120' + 'ff'.repeat(32))
    })
    expect(() =>
      registry.finalization(proposal, Utils.toBase64(transaction.toBinary()), 'ff'.repeat(32))
    ).toThrow('mismatch')
    expect(() =>
      registry.finalization(
        proposal,
        Utils.toBase64([...transaction.toBinary(), 0]),
        transaction.id('hex')
      )
    ).toThrow()
    const withdrawn = signed({ operation: 'withdraw' })
    expect(() => checkFinalization(withdrawn, finalize(withdrawn))).toThrow('mismatch')
  })

  it('requires the optional anchor at input zero, independently of later BEEF and admission checks', () => {
    const proposal = signed({ anchors: [{ chain, txid: '03'.repeat(32), outputIndex: 2 }] })
    const tx = finalize(proposal)
    expect(() => checkFinalization(proposal, tx)).not.toThrow()
    tx.inputs[0].sourceOutputIndex = 3
    expect(() => checkFinalization(proposal, tx)).toThrow('anchor at input zero')
    tx.inputs[0].sourceOutputIndex = 2
    tx.inputs[0].sourceTXID = '04'.repeat(32)
    expect(() => checkFinalization(proposal, tx)).toThrow('anchor at input zero')
    tx.inputs = []
    expect(() => checkFinalization(proposal, tx)).toThrow('anchor at input zero')
  })
})
