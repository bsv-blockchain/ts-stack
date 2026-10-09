import {
  bindOutputReleaseEvidence,
  canonicalOutputJSON,
  OUTPUT_PROCESSOR_ATTESTATION_POLICY,
  parseOutputReleaseEvidence,
  parseOutputReleasePolicy,
  PrivateKey,
  signOutputPacket,
  Utils,
  verifyOutputProcessorAcceptance,
  type OutputReleaseEvidence
} from '../../../mod.js'

const chain = { network: 'release-fixture', genesisHash: '11'.repeat(32) }
const txid = '22'.repeat(32)
const signer = new PrivateKey(77) // Disclosed synthetic test authority only.
const identity = signer.toPublicKey().toString()
const local = () => ({
  chain: { ...chain },
  txid,
  policy: { kind: 'local-admission' },
  acceptedAt: '10'
})
const mined = () => ({
  ...local(),
  policy: { kind: 'mined', confirmations: 3 },
  blockEvidence: {
    blockHash: '33'.repeat(32),
    height: '100',
    tipHash: '44'.repeat(32),
    tipHeight: '102',
    beef: 'AA==',
    contextId: 'selected-fixture-view',
    chainPolicyDigest: '55'.repeat(32)
  }
})
function accepted() {
  const body = {
    version: 1,
    chain: { ...chain },
    txid,
    policy: OUTPUT_PROCESSOR_ATTESTATION_POLICY,
    acceptedAt: '10'
  }
  const packet = signOutputPacket('processor-acceptance', body, signer)
  const policy = {
    kind: 'processor-accepted' as const,
    identity,
    policy: OUTPUT_PROCESSOR_ATTESTATION_POLICY
  }
  const evidence = {
    ...local(),
    policy,
    processorEvidence: Utils.toBase64(Utils.toArray(canonicalOutputJSON(packet), 'utf8'))
  }
  return { body, packet, evidence, binding: { chain: { ...chain }, txid, policy } }
}

describe('BRC-196 release representations and attributable processor acceptance', () => {
  it.each([
    { kind: 'local-admission' },
    { kind: 'processor-accepted', identity, policy: OUTPUT_PROCESSOR_ATTESTATION_POLICY },
    { kind: 'mined', confirmations: 1 },
    { kind: 'mined', confirmations: 0xffffffff }
  ])('owns the selected $kind policy without inventing an acceptance verdict', policy => {
    expect(parseOutputReleasePolicy(policy)).toEqual(policy)
    expect(() => parseOutputReleasePolicy({ ...policy, paid: true })).toThrow('Unknown')
  })

  it.each([0, -1, 1.5, 0x100000000, '1'])(
    'rejects invalid confirmation count %s',
    confirmations => {
      expect(() => parseOutputReleasePolicy({ kind: 'mined', confirmations })).toThrow()
    }
  )

  it('owns nested data and accepts JSON bytes without treating opaque BEEF as verified', () => {
    const input = mined()
    const result = parseOutputReleaseEvidence(new TextEncoder().encode(JSON.stringify(input)))
    expect(result).toEqual(input)
    input.blockEvidence.beef = 'AQ=='
    input.chain.network = 'changed'
    expect(result.blockEvidence!.beef).toBe('AA==')
    expect(result.chain.network).toBe(chain.network)
    expect(parseOutputReleaseEvidence(local())).toEqual(local())
    const processorEvidence = accepted().evidence
    expect(parseOutputReleaseEvidence(processorEvidence)).toEqual(processorEvidence)
  })

  it('requires exactly the evidence fields selected by each release policy', () => {
    const processor = accepted().evidence
    const values = [
      { ...local(), processorEvidence: 'AA==' },
      { ...local(), blockEvidence: mined().blockEvidence },
      { ...processor, blockEvidence: mined().blockEvidence },
      { ...mined(), processorEvidence: 'AA==' },
      { ...local(), policy: processor.policy },
      { ...local(), policy: mined().policy }
    ]
    for (const input of values)
      expect(() => parseOutputReleaseEvidence(input)).toThrow('fields differ')
  })

  it('checks declared depth with exact U64 arithmetic, including the maximum height', () => {
    const input = mined()
    input.blockEvidence.height = '18446744073709551613'
    input.blockEvidence.tipHeight = '18446744073709551615'
    expect(parseOutputReleaseEvidence(input)).toEqual(input)
    input.blockEvidence.height = '18446744073709551614'
    expect(() => parseOutputReleaseEvidence(input)).toThrow('confirmation depth')
    input.blockEvidence.height = '18446744073709551616'
    expect(() => parseOutputReleaseEvidence(input)).toThrow()
    input.blockEvidence.height = '103'
    input.blockEvidence.tipHeight = '102'
    expect(() => parseOutputReleaseEvidence(input)).toThrow('confirmation depth')
  })

  it('requires the same hash when the containing block is itself the declared tip', () => {
    const input = mined()
    input.policy.confirmations = 1
    input.blockEvidence.tipHeight = input.blockEvidence.height
    expect(() => parseOutputReleaseEvidence(input)).toThrow('Same-height')
    input.blockEvidence.tipHash = input.blockEvidence.blockHash
    expect(parseOutputReleaseEvidence(input)).toEqual(input)
  })

  it('binds chain, transaction and the entire independently selected policy', () => {
    const input = parseOutputReleaseEvidence(mined())
    const binding = { chain, txid, policy: input.policy }
    expect(bindOutputReleaseEvidence(input, binding)).toEqual(input)
    for (const changed of [
      { ...binding, chain: { ...chain, network: 'other' } },
      { ...binding, chain: { ...chain, genesisHash: '66'.repeat(32) } },
      { ...binding, txid: '77'.repeat(32) },
      { ...binding, policy: { kind: 'mined' as const, confirmations: 2 } },
      { ...binding, policy: { kind: 'local-admission' as const } }
    ])
      expect(() => bindOutputReleaseEvidence(input, changed)).toThrow('binding mismatch')
  })

  it('verifies the exact signed processor statement with an independently selected identity', () => {
    const { evidence, binding, packet } = accepted()
    expect(verifyOutputProcessorAcceptance(evidence, binding)).toEqual(packet)
    const foreign = {
      ...evidence,
      policy: { ...evidence.policy, identity: new PrivateKey(78).toPublicKey().toString() }
    }
    expect(() => verifyOutputProcessorAcceptance(foreign, binding)).toThrow('binding mismatch')
    expect(() =>
      verifyOutputProcessorAcceptance(foreign, { ...binding, policy: foreign.policy })
    ).toThrow('Unexpected packet signer')
  })

  it.each(['chain', 'txid', 'policy', 'acceptedAt'] as const)(
    'rejects a signed statement with different %s',
    field => {
      const { body, evidence, binding } = accepted()
      const changed = {
        ...body,
        [field]:
          field === 'chain'
            ? { ...chain, network: 'other' }
            : field === 'txid'
              ? '88'.repeat(32)
              : field === 'policy'
                ? 'urn:other:policy'
                : '11'
      }
      const packet = signOutputPacket('processor-acceptance', changed, signer)
      evidence.processorEvidence = Utils.toBase64(
        Utils.toArray(canonicalOutputJSON(packet), 'utf8')
      )
      expect(() => verifyOutputProcessorAcceptance(evidence, binding)).toThrow(
        'attestation binding mismatch'
      )
    }
  )

  it('rejects another signature domain and noncanonical or malformed processor JSON bytes', () => {
    const { body, packet, evidence, binding } = accepted()
    const wrongDomain = signOutputPacket('potatoes', body, signer)
    evidence.processorEvidence = Utils.toBase64(
      Utils.toArray(canonicalOutputJSON(wrongDomain), 'utf8')
    )
    expect(() => verifyOutputProcessorAcceptance(evidence, binding)).toThrow('signature failed')
    expect(() => verifyOutputProcessorAcceptance(evidence, binding)).toThrow(
      expect.objectContaining({ code: 'unauthorized' })
    )
    evidence.processorEvidence = Utils.toBase64(
      Utils.toArray(JSON.stringify(packet, null, 2), 'utf8')
    )
    expect(() => verifyOutputProcessorAcceptance(evidence, binding)).toThrow('canonical JSON')
    evidence.processorEvidence = Utils.toBase64([0xff])
    expect(() => verifyOutputProcessorAcceptance(evidence, binding)).toThrow()
  })

  it('does not silently verify unknown processor formats or a non-processor policy', () => {
    const { evidence, binding } = accepted()
    evidence.policy = { ...evidence.policy, policy: 'urn:future:processor-policy' }
    expect(parseOutputReleaseEvidence(evidence)).toEqual(evidence)
    expect(() =>
      verifyOutputProcessorAcceptance(evidence, { ...binding, policy: evidence.policy })
    ).toThrow('Unsupported')
    expect(() =>
      verifyOutputProcessorAcceptance(evidence, { ...binding, policy: evidence.policy })
    ).toThrow(expect.objectContaining({ code: 'unsupported' }))
    const input = parseOutputReleaseEvidence(local())
    expect(() =>
      verifyOutputProcessorAcceptance(input, { chain, txid, policy: input.policy })
    ).toThrow('Processor policy required')
  })

  it('rejects extra claimed trust facts, invalid encodings and accessors without evaluating them', () => {
    const input: OutputReleaseEvidence = parseOutputReleaseEvidence(mined())
    expect(() => parseOutputReleaseEvidence({ ...input, verified: true })).toThrow('Unknown')
    expect(() =>
      parseOutputReleaseEvidence({
        ...input,
        blockEvidence: { ...input.blockEvidence, verified: true }
      })
    ).toThrow('Unknown')
    expect(() => parseOutputReleaseEvidence({ ...input, acceptedAt: '01' })).toThrow()
    expect(() =>
      parseOutputReleaseEvidence({
        ...input,
        blockEvidence: { ...input.blockEvidence, beef: 'AB==' }
      })
    ).toThrow()
    const getter = jest.fn(() => chain)
    Object.defineProperty(input, 'chain', { enumerable: true, get: getter })
    expect(() => parseOutputReleaseEvidence(input)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('fresh release ownership and intrinsic checks after parent normalization', () => {
  it('checks mutated policy and block arithmetic again without retaining a prior verdict', () => {
    const input = mined()
    const owned = parseOutputReleaseEvidence(input)
    input.policy.confirmations = 4
    expect(() => parseOutputReleaseEvidence(input)).toThrow('confirmation depth')
    expect(owned.policy).toEqual({ kind: 'mined', confirmations: 3 })
    input.policy.confirmations = 0
    expect(() => parseOutputReleaseEvidence(input)).toThrow('Expected positive limit')
    input.policy.confirmations = 1
    input.blockEvidence.tipHeight = '100'
    expect(() => parseOutputReleaseEvidence(input)).toThrow('Same-height release headers differ')
    input.blockEvidence.tipHash = input.blockEvidence.blockHash
    expect(parseOutputReleaseEvidence(input).blockEvidence!.tipHeight).toBe('100')
    expect(owned.blockEvidence!.tipHeight).toBe('102')
    Object.assign(input.policy, { releaseNow: true })
    expect(() => parseOutputReleaseEvidence(input)).toThrow('Unknown')
  })

  it('rejects duplicate nested fields in original UTF-8 and preserves Unicode error order', () => {
    const input = mined()
    const encoded = JSON.stringify(input)
    const duplicate = encoded.replace('"confirmations":3', '"confirmations":2,"confirmations":3')
    expect(duplicate).not.toBe(encoded)
    expect(() => parseOutputReleaseEvidence(duplicate)).toThrow('Duplicate')
    expect(() => parseOutputReleaseEvidence(new TextEncoder().encode(duplicate))).toThrow(
      'Duplicate'
    )
    Object.assign(input.policy, { unknown: '\udfff' })
    expect(() => parseOutputReleaseEvidence(input)).toThrow('Unpaired JSON surrogate')
    expect(() => parseOutputReleaseEvidence(JSON.stringify(input))).toThrow(
      'Unpaired JSON surrogate'
    )
  })
})

import {
  parseOutputReleaseEvidenceWithInlineStrings,
  bindOutputReleaseEvidenceWithInlineStrings,
  OutputProtocolError
} from '../../../mod.js'

function releaseCompanionOutcome(work: () => unknown): unknown {
  try {
    return { value: work() }
  } catch (error) {
    if (!(error instanceof OutputProtocolError)) throw error
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
}

it('keeps release companions fresh across policies, intrinsic arithmetic, bindings and malformed framing', () => {
  for (const input of [local(), mined(), accepted().evidence]) {
    const binding = { chain, txid, policy: parseOutputReleasePolicy(input.policy) },
      text = canonicalOutputJSON(input)
    for (const representation of [input, text, new TextEncoder().encode(text)]) {
      expect(parseOutputReleaseEvidenceWithInlineStrings(representation)).toEqual(
        parseOutputReleaseEvidence(representation)
      )
      expect(bindOutputReleaseEvidenceWithInlineStrings(representation, binding)).toEqual(
        bindOutputReleaseEvidence(representation, binding)
      )
    }
    for (const expected of [
      binding,
      { ...binding, txid: '99'.repeat(32) },
      { ...binding, chain: { ...chain, network: 'other' } },
      { ...binding, policy: { kind: 'local-admission' as const } }
    ]) {
      expect(
        releaseCompanionOutcome(() => bindOutputReleaseEvidenceWithInlineStrings(input, expected))
      ).toEqual(releaseCompanionOutcome(() => bindOutputReleaseEvidence(input, expected)))
    }
    for (const candidate of [
      { ...input, acceptedAt: '01' },
      { ...input, unknown: true },
      { ...input, processorEvidence: 'AA==' },
      { ...input, blockEvidence: mined().blockEvidence }
    ]) {
      expect(
        releaseCompanionOutcome(() => parseOutputReleaseEvidenceWithInlineStrings(candidate))
      ).toEqual(releaseCompanionOutcome(() => parseOutputReleaseEvidence(candidate)))
    }
  }
  const input = mined(),
    owned = parseOutputReleaseEvidenceWithInlineStrings(input)
  for (const fields of [
    { height: '100', tipHeight: '99' },
    { height: '100', tipHeight: '101' },
    { height: '100', tipHeight: '100' },
    { height: '100', tipHeight: '100', tipHash: input.blockEvidence.blockHash },
    { height: '100', tipHeight: '102' }
  ]) {
    const candidate = { ...input, blockEvidence: { ...input.blockEvidence, ...fields } }
    expect(
      releaseCompanionOutcome(() => parseOutputReleaseEvidenceWithInlineStrings(candidate))
    ).toEqual(releaseCompanionOutcome(() => parseOutputReleaseEvidence(candidate)))
  }
  input.blockEvidence.tipHeight = '0'
  expect(owned.blockEvidence!.tipHeight).toBe('102')
  expect(() => parseOutputReleaseEvidenceWithInlineStrings(input)).toThrow('confirmation depth')
  expect(parseOutputReleaseEvidenceWithInlineStrings(mined()).blockEvidence!.tipHeight).toBe('102')
  const accessor = Object.defineProperty(local(), 'acceptedAt', {
    enumerable: true,
    get() {
      throw new Error('Accessor must not run')
    }
  })
  for (const candidate of [
    accessor,
    { ...local(), [Symbol('unknown')]: true },
    '{"chain":{},"chain":{}}'
  ]) {
    expect(
      releaseCompanionOutcome(() => parseOutputReleaseEvidenceWithInlineStrings(candidate))
    ).toEqual(releaseCompanionOutcome(() => parseOutputReleaseEvidence(candidate)))
  }
})

it('retains nested policy text, duplicate-key refusal and fresh ownership in composed release schemas', () => {
  for (const evidence of [local(), mined(), accepted().evidence]) {
    const input = { ...evidence, policy: canonicalOutputJSON(evidence.policy) }
    expect(
      releaseCompanionOutcome(() => parseOutputReleaseEvidenceWithInlineStrings(input))
    ).toEqual(releaseCompanionOutcome(() => parseOutputReleaseEvidence(input)))
    const original = parseOutputReleaseEvidenceWithInlineStrings(input)
    input.policy = '{"kind":"local-admission","kind":"mined"}'
    expect(
      releaseCompanionOutcome(() => parseOutputReleaseEvidenceWithInlineStrings(input))
    ).toEqual(releaseCompanionOutcome(() => parseOutputReleaseEvidence(input)))
    expect(original.policy).toEqual(evidence.policy)
  }
  const input = mined(),
    binding = { chain, txid, policy: parseOutputReleasePolicy(input.policy) }
  const represented = { ...input, policy: canonicalOutputJSON(input.policy) }
  expect(bindOutputReleaseEvidenceWithInlineStrings(represented, binding)).toEqual(
    bindOutputReleaseEvidence(represented, binding)
  )
  const malformed = { ...represented, blockEvidence: { ...input.blockEvidence, height: '01' } }
  expect(
    releaseCompanionOutcome(() => bindOutputReleaseEvidenceWithInlineStrings(malformed, binding))
  ).toEqual(releaseCompanionOutcome(() => bindOutputReleaseEvidence(malformed, binding)))
})
