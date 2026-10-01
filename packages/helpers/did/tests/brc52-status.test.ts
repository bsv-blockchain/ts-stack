import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { verifyBRC52CertificateBinary } from '../src/brc52/envelope.js'
import { createSyntheticBRC52Binary } from './fixtures/brc52-synthetic.js'
import {
  evaluateBRC52Status,
  type BRC52StatusObservation,
  type BRC52StatusPolicy
} from '../src/brc52/status.js'

const fixture = JSON.parse(
  readFileSync(`${process.cwd()}/tests/fixtures/brc203-envelope.json`, 'utf8')
) as {
  certificateBinary: string
}
const binary = Array.from(Buffer.from(fixture.certificateBinary, 'base64'))
const outpoint = `${'33'.repeat(32)}.1`

function observation(changes: Partial<BRC52StatusObservation> = {}): BRC52StatusObservation {
  return {
    outpoint,
    network: 'synthetic-offline',
    source: 'local-test-view',
    observedAt: 1000,
    exists: true,
    state: 'unspent',
    confirmations: 6,
    reorganization: 'stable',
    evidence: { kind: 'provider-assertion', reference: 'offline-observation-1' },
    ...changes
  }
}

function policy(received: unknown = observation()): BRC52StatusPolicy {
  return {
    network: 'synthetic-offline',
    source: 'local-test-view',
    acceptedEvidence: ['provider-assertion'],
    maxAgeMs: 100,
    now: 1050,
    minConfirmations: 6,
    unconfirmedSpends: 'unknown',
    reorganization: 'require-stable',
    retrieval: {
      mode: 'local-chain-view',
      issuerTracking: 'prevented',
      protection: 'Offline locally maintained view; no queries leave this process.',
      thirdPartyCorrelation: 'none',
      evidenceValidation: {
        kind: 'provider-assertion',
        procedure: 'Offline mock source assertion only; no chain proof is validated.'
      },
      retrieve: jest.fn(async () => received)
    }
  }
}

afterEach(() => jest.restoreAllMocks())

describe('BRC-203 status evaluator with the frozen public BRC-52 vector', () => {
  test('rejects malformed local objects with precise configuration errors before retrieval', async () => {
    for (const input of [undefined, null, 1, 'policy', [], () => policy()]) {
      await expect(
        evaluateBRC52Status(binary, input as unknown as BRC52StatusPolicy)
      ).rejects.toThrow('Expected a bounded own-data object')
    }
    for (const input of [
      new Date(0),
      Object.assign(Object.create({ inherited: true }) as object, policy())
    ]) {
      await expect(evaluateBRC52Status(binary, input as BRC52StatusPolicy)).rejects.toThrow(
        'Expected a plain own-data object'
      )
    }
    const unknownMember = policy() as unknown as Record<string, unknown>
    delete unknownMember.now
    unknownMember.unsignedPolicy = true
    await expect(
      evaluateBRC52Status(binary, unknownMember as unknown as BRC52StatusPolicy)
    ).rejects.toThrow('Unexpected object members')
    const symbolMember = policy() as unknown as Record<PropertyKey, unknown>
    delete symbolMember.now
    symbolMember[Symbol('unsigned-policy')] = true
    await expect(
      evaluateBRC52Status(binary, symbolMember as unknown as BRC52StatusPolicy)
    ).rejects.toThrow('Unexpected object members')
    const accessor = policy()
    const read = jest.fn(() => 1050)
    Object.defineProperty(accessor, 'now', { get: read, enumerable: true })
    await expect(evaluateBRC52Status(binary, accessor)).rejects.toThrow(
      'Accessors are not accepted'
    )
    expect(read).not.toHaveBeenCalled()
    // A benign controlled proxy exposes a claimed own key without own data.
    const absentOwnData = new Proxy({}, { ownKeys: () => ['network'] })
    await expect(evaluateBRC52Status(binary, absentOwnData as BRC52StatusPolicy)).rejects.toThrow(
      'Accessors are not accepted'
    )
  })

  test('accepts null-prototype own-data policy/observations and returns JSON-compatible privacy metadata', async () => {
    const selected = Object.assign(Object.create(null) as BRC52StatusPolicy, policy())
    selected.retrieval = Object.assign(
      Object.create(null) as BRC52StatusPolicy['retrieval'],
      selected.retrieval
    )
    selected.retrieval.evidenceValidation = Object.assign(
      Object.create(null) as typeof selected.retrieval.evidenceValidation,
      selected.retrieval.evidenceValidation
    )
    const received = Object.assign(Object.create(null) as BRC52StatusObservation, observation())
    received.evidence = Object.assign(
      Object.create(null) as BRC52StatusObservation['evidence'],
      received.evidence
    )
    selected.retrieval.retrieve = async () => received
    const result = await evaluateBRC52Status(binary, selected)
    expect(result.status).toBe('notRevokedAsOf')
    expect(Object.hasOwn(result.privacy, 'correlationLimitation')).toBe(false)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  test.each([
    ['network', 128],
    ['source', 256],
    ['protection', 1024],
    ['correlationLimitation', 1024],
    ['procedure', 1024]
  ] as const)(
    'enforces %s text bounds and control-character policy without truncation',
    async (member, maximum) => {
      function configure(value: unknown): BRC52StatusPolicy {
        const selected = policy()
        if (member === 'network') selected.network = value as string
        else if (member === 'source') selected.source = value as string
        else if (member === 'procedure')
          selected.retrieval.evidenceValidation.procedure = value as string
        else selected.retrieval[member] = value as string
        selected.retrieval.retrieve = async () =>
          observation({ network: selected.network, source: selected.source })
        return selected
      }
      for (const input of [
        undefined,
        null,
        false,
        1,
        '',
        'x'.repeat(maximum + 1),
        'x\u0000',
        'x\u001f',
        'x\u007f'
      ]) {
        // Omission is permitted only for the optional correlation-limitation member.
        if (member === 'correlationLimitation' && input === undefined) continue
        await expect(evaluateBRC52Status(binary, configure(input))).rejects.toThrow(
          'Expected bounded text'
        )
      }
      for (const input of ['x', 'x'.repeat(maximum), 'x\u0020', 'x\u007e', 'x\u0080']) {
        expect(await evaluateBRC52Status(binary, configure(input))).toMatchObject({
          status: 'notRevokedAsOf'
        })
      }
    }
  )

  test.each(['maxAgeMs', 'now', 'minConfirmations'] as const)(
    'rejects unsafe %s configuration with the integer diagnostic',
    async member => {
      for (const input of [
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '6',
        true,
        undefined
      ]) {
        const selected = policy()
        selected[member] = input as number
        await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow(
          'Expected a nonnegative safe integer'
        )
        expect(selected.retrieval.retrieve).not.toHaveBeenCalled()
      }
    }
  )

  test('enforces dense own-data evidence choices, uniqueness and all supported choices at the exact limit', async () => {
    for (const choices of [
      undefined,
      null,
      'provider-assertion',
      {},
      [],
      [
        'provider-assertion',
        'authenticated-view',
        'independently-validated-chain',
        'provider-assertion'
      ]
    ]) {
      const selected = policy()
      selected.acceptedEvidence = choices as BRC52StatusPolicy['acceptedEvidence']
      await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow(
        'Select one or more evidence kinds'
      )
    }
    const sparse: string[] = []
    sparse.length = 2
    const extraMember = ['provider-assertion']
    Object.assign(extraMember, { extra: 'unsigned' })
    for (const choices of [sparse, extraMember]) {
      const selected = policy()
      selected.acceptedEvidence = choices as BRC52StatusPolicy['acceptedEvidence']
      await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow(
        'Invalid evidence choices'
      )
    }
    const read = jest.fn(() => 'provider-assertion')
    const accessor = ['provider-assertion']
    Object.defineProperty(accessor, '0', { get: read, enumerable: true })
    const holeWithExtra: string[] = []
    holeWithExtra.length = 2
    holeWithExtra[0] = 'provider-assertion'
    Object.assign(holeWithExtra, { extra: 'balances descriptor count but not the missing entry' })
    for (const choices of [accessor, holeWithExtra]) {
      const selected = policy()
      selected.acceptedEvidence = choices as BRC52StatusPolicy['acceptedEvidence']
      await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow(
        'Invalid evidence choices'
      )
    }
    expect(read).not.toHaveBeenCalled()
    const duplicate = policy()
    duplicate.acceptedEvidence = ['provider-assertion', 'provider-assertion']
    await expect(evaluateBRC52Status(binary, duplicate)).rejects.toThrow(
      'Duplicate evidence choices'
    )
    const invalid = policy()
    invalid.acceptedEvidence = [false] as unknown as BRC52StatusPolicy['acceptedEvidence']
    await expect(evaluateBRC52Status(binary, invalid)).rejects.toThrow('Invalid policy choice')
    const complete = policy()
    complete.acceptedEvidence = [
      'provider-assertion',
      'authenticated-view',
      'independently-validated-chain'
    ]
    expect(await evaluateBRC52Status(binary, complete)).toMatchObject({ status: 'notRevokedAsOf' })
  })

  test('rejects a missing retrieval function as configuration rather than a provider failure', async () => {
    for (const retrieve of [undefined, null, true, 'retrieve', {}]) {
      const selected = policy()
      selected.retrieval.retrieve = retrieve as BRC52StatusPolicy['retrieval']['retrieve']
      await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow(
        'A status retrieval adapter is required'
      )
    }
  })

  test.each([
    ['unconfirmedSpends', 'invalid'],
    ['reorganization', false],
    ['mode', 'issuer-url'],
    ['issuerTracking', true],
    ['thirdPartyCorrelation', false],
    ['kind', 'independent-proof']
  ])('rejects invalid %s choices with an exact local policy diagnostic', async (member, input) => {
    const selected = policy()
    if (member === 'unconfirmedSpends' || member === 'reorganization')
      Object.assign(selected, { [member]: input })
    else if (member === 'kind')
      Object.assign(selected.retrieval.evidenceValidation, { kind: input })
    else Object.assign(selected.retrieval, { [member]: input })
    await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow('Invalid policy choice')
    expect(selected.retrieval.retrieve).not.toHaveBeenCalled()
  })

  test.each([
    { exists: undefined },
    { exists: 'false' },
    { exists: 1 },
    { observedAt: -1 },
    { observedAt: 1.5 },
    { observedAt: Number.MAX_SAFE_INTEGER + 1 },
    { confirmations: -1 },
    { confirmations: '6' },
    { confirmations: NaN },
    { evidence: { kind: 'provider-assertion', reference: '' } },
    { evidence: { kind: 'provider-assertion', reference: 'x'.repeat(1025) } },
    { evidence: { kind: 'provider-assertion', reference: 'x\u007f' } },
    { state: 'current' },
    { reorganization: 'accepted' }
  ])(
    'rejects malformed runtime observation %# without interpreting truthy input as existence',
    async changes => {
      expect(
        await evaluateBRC52Status(binary, policy({ ...observation(), ...changes }))
      ).toMatchObject({ status: 'unknown', reason: 'invalid-observation' })
    }
  )

  test('accepts the exact freshness endpoints and safe integer endpoints under explicit local policy', async () => {
    for (const observedAt of [950, 1050]) {
      expect(await evaluateBRC52Status(binary, policy(observation({ observedAt })))).toMatchObject({
        status: 'notRevokedAsOf',
        observedAt
      })
    }
    for (const now of [0, Number.MAX_SAFE_INTEGER]) {
      const selected = policy(observation({ observedAt: now, confirmations: 0 }))
      selected.now = now
      selected.maxAgeMs = 0
      selected.minConfirmations = 0
      expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
        status: 'notRevokedAsOf',
        observedAt: now
      })
    }
    const maximumReference = observation({
      evidence: { kind: 'provider-assertion', reference: 'x'.repeat(1024) }
    })
    expect(await evaluateBRC52Status(binary, policy(maximumReference))).toMatchObject({
      status: 'notRevokedAsOf',
      evidence: maximumReference.evidence
    })
  })

  test.each([
    ['spent', 0, 0, 'unknown', 'unknown'],
    ['spent', 0, 6, 'accept', 'revoked'],
    ['spent', 1, 6, 'accept', 'unknown'],
    ['spent', 5, 6, 'accept', 'unknown'],
    ['spent', 6, 6, 'unknown', 'revoked'],
    ['unspent', 0, 0, 'unknown', 'notRevokedAsOf'],
    ['unspent', 0, 6, 'accept', 'unknown'],
    ['unspent', 5, 6, 'accept', 'unknown'],
    ['unspent', 6, 6, 'accept', 'notRevokedAsOf']
  ] as const)(
    'separates state %s/depth %i/minimum %i/unconfirmed %s',
    async (state, confirmations, minConfirmations, unconfirmedSpends, expected) => {
      const selected = policy(observation({ state, confirmations }))
      selected.minConfirmations = minConfirmations
      selected.unconfirmedSpends = unconfirmedSpends
      const result = await evaluateBRC52Status(binary, selected)
      expect(result.status).toBe(expected)
      if (expected === 'unknown') expect(result.reason).toBe('chain-policy-insufficient')
    }
  )

  test('allows pending reorganizations only when selected, and never competing observations', async () => {
    const selected = policy(observation({ reorganization: 'pending' }))
    expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
      status: 'unknown',
      reason: 'chain-policy-insufficient'
    })
    selected.reorganization = 'accept-pending'
    expect(await evaluateBRC52Status(binary, selected)).toMatchObject({ status: 'notRevokedAsOf' })
    selected.retrieval.retrieve = async () => observation({ reorganization: 'conflicting' })
    expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
      status: 'unknown',
      reason: 'chain-policy-insufficient'
    })
  })

  test('reports current unspent evidence and passes only an immutable outpoint/network query', async () => {
    const selected = policy()
    const result = await evaluateBRC52Status(binary, selected)
    expect(selected.retrieval.retrieve).toHaveBeenCalledWith({
      outpoint,
      network: 'synthetic-offline'
    })
    const query = (selected.retrieval.retrieve as jest.Mock).mock.calls[0][0] as object
    expect(Object.isFrozen(query)).toBe(true)
    expect(Object.keys(query)).toEqual(['outpoint', 'network'])
    expect(result).toMatchObject({
      status: 'notRevokedAsOf',
      outpoint,
      observedAt: 1000,
      source: 'local-test-view',
      evidence: { kind: 'provider-assertion', reference: 'offline-observation-1' },
      privacy: { retrievalAttempted: true, thirdPartyCorrelation: 'none' }
    })
    expect(result.evidence?.kind).not.toBe('independently-validated-chain')
  })

  test('reports an accepted spend as revoked', async () => {
    expect(
      await evaluateBRC52Status(binary, policy(observation({ state: 'spent' })))
    ).toMatchObject({ status: 'revoked' })
  })

  test.each(['authenticated-view', 'independently-validated-chain'] as const)(
    'reports %s only when that locally configured evidence kind is accepted',
    async kind => {
      const selected = policy(
        observation({ evidence: { kind, reference: 'adapter-validation-record' } })
      )
      expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
        status: 'unknown',
        reason: 'unaccepted-evidence'
      })
      selected.acceptedEvidence = [kind]
      expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
        status: 'unknown',
        reason: 'unaccepted-evidence'
      })
      selected.retrieval.evidenceValidation = {
        kind,
        procedure: 'Offline synthetic test of this classification; no live chain validation claim.'
      }
      expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
        status: 'notRevokedAsOf',
        evidence: { kind }
      })
    }
  )

  test.each([
    [undefined, 'invalid-observation'],
    [null, 'invalid-observation'],
    [{}, 'invalid-observation'],
    [observation({ outpoint: `${'44'.repeat(32)}.1` }), 'invalid-observation'],
    [observation({ network: 'other-network' }), 'invalid-observation'],
    [observation({ source: 'other-source' }), 'invalid-observation'],
    [observation({ exists: false }), 'outpoint-does-not-exist'],
    [observation({ observedAt: 949 }), 'stale-observation'],
    [observation({ observedAt: 1051 }), 'stale-observation'],
    [observation({ confirmations: 5 }), 'chain-policy-insufficient'],
    [observation({ reorganization: 'pending' }), 'chain-policy-insufficient'],
    [observation({ reorganization: 'conflicting' }), 'chain-policy-insufficient'],
    [observation({ state: 'spent', confirmations: 0 }), 'chain-policy-insufficient']
  ])('returns unknown for insufficient observation %#', async (received, reason) => {
    const selected = policy()
    selected.retrieval.retrieve = async () => received
    expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
      status: 'unknown',
      reason
    })
  })

  test('retrieval errors cannot establish a current certificate', async () => {
    const selected = policy()
    selected.retrieval.retrieve = jest.fn(async () => {
      throw new Error('offline unavailable')
    })
    expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
      status: 'unknown',
      reason: 'retrieval-failed'
    })
  })

  test('uses explicit unconfirmed-spend and reorganization decisions', async () => {
    const selected = policy(
      observation({ state: 'spent', confirmations: 0, reorganization: 'pending' })
    )
    selected.unconfirmedSpends = 'accept'
    expect(await evaluateBRC52Status(binary, selected)).toMatchObject({ status: 'unknown' })
    selected.reorganization = 'accept-pending'
    expect(await evaluateBRC52Status(binary, selected)).toMatchObject({ status: 'revoked' })
    selected.retrieval.retrieve = async () =>
      observation({ state: 'spent', confirmations: 0, reorganization: 'conflicting' })
    expect(await evaluateBRC52Status(binary, selected)).toMatchObject({ status: 'unknown' })
  })

  test.each(['issuer-per-presentation', 'batched-cached'] as const)(
    'refuses issuer tracking for %s before retrieval',
    async mode => {
      const selected = policy()
      selected.retrieval.mode = mode
      if (mode === 'batched-cached') selected.retrieval.issuerTracking = 'possible'
      expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
        status: 'unknown',
        reason: 'issuer-tracking-prohibited',
        privacy: { retrievalAttempted: false }
      })
      expect(selected.retrieval.retrieve).not.toHaveBeenCalled()
    }
  )

  test('discloses other provider correlation under an explicitly documented batching/cache contract', async () => {
    const selected = policy()
    selected.retrieval.mode = 'batched-cached'
    selected.retrieval.protection =
      'Verifier preloads independently scheduled batches; issuer cannot observe presentation requests.'
    selected.retrieval.thirdPartyCorrelation = 'possible'
    selected.retrieval.correlationLimitation =
      'The cache operator can correlate outpoints and the verifier connection.'
    expect(await evaluateBRC52Status(binary, selected)).toMatchObject({
      status: 'notRevokedAsOf',
      privacy: {
        thirdPartyCorrelation: 'possible',
        correlationLimitation: selected.retrieval.correlationLimitation
      }
    })
    delete selected.retrieval.correlationLimitation
    await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow('correlation')
  })

  test('invalid signed binary is rejected before retrieval or a wrapper outpoint can be accepted', async () => {
    const selected = policy()
    const tampered = [...binary]
    tampered[130] ^= 1
    await expect(evaluateBRC52Status(tampered, selected)).rejects.toThrow()
    await expect(evaluateBRC52Status(fixture as unknown as number[], selected)).rejects.toThrow()
    expect(selected.retrieval.retrieve).not.toHaveBeenCalled()
  })

  test('never queries the exact signed disabled sentinel', async () => {
    const syntheticBinary = createSyntheticBRC52Binary()
    expect(verifyBRC52CertificateBinary(syntheticBinary).revocationOutpoint).toBe(
      `${'0'.repeat(64)}.0`
    )
    const selected = policy()
    expect(await evaluateBRC52Status(syntheticBinary, selected)).toMatchObject({
      status: 'disabled',
      privacy: { retrievalAttempted: false }
    })
    expect(selected.retrieval.retrieve).not.toHaveBeenCalled()
  })

  test('signed all-zero txid with nonzero vout is queried as a real outpoint', async () => {
    const signedOutpoint = `${'0'.repeat(64)}.1`
    const syntheticBinary = createSyntheticBRC52Binary([], signedOutpoint)
    expect(verifyBRC52CertificateBinary(syntheticBinary).revocationOutpoint).toBe(signedOutpoint)
    const selected = policy(observation({ outpoint: signedOutpoint }))
    expect(await evaluateBRC52Status(syntheticBinary, selected)).toMatchObject({
      status: 'notRevokedAsOf',
      outpoint: signedOutpoint
    })
    expect(selected.retrieval.retrieve).toHaveBeenCalledWith({
      outpoint: signedOutpoint,
      network: 'synthetic-offline'
    })
  })

  test('snapshots local policy before awaiting a provider and owns returned evidence', async () => {
    const received = observation()
    const selected = policy(received)
    selected.retrieval.retrieve = async () => {
      selected.source = 'mutated-source'
      selected.network = 'mutated-network'
      selected.acceptedEvidence = []
      selected.now = 1
      return received
    }
    const result = await evaluateBRC52Status(binary, selected)
    received.evidence.reference = 'later mutation'
    expect(result).toMatchObject({
      status: 'notRevokedAsOf',
      network: 'synthetic-offline',
      evidence: { reference: 'offline-observation-1' }
    })
  })

  test('rejects malformed own-data observations without invoking accessors', async () => {
    const getter = jest.fn(() => true)
    const received = observation()
    Object.defineProperty(received, 'exists', { get: getter })
    expect(await evaluateBRC52Status(binary, policy(received))).toMatchObject({
      status: 'unknown',
      reason: 'invalid-observation'
    })
    expect(getter).not.toHaveBeenCalled()
    expect(
      await evaluateBRC52Status(binary, policy({ ...observation(), extra: 'unsigned fact' }))
    ).toMatchObject({ status: 'unknown' })
  })

  test('rejects invalid local policy and boolean proof/privacy shortcuts', async () => {
    const selected = policy()
    selected.maxAgeMs = -1
    await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow()
    selected.maxAgeMs = 100
    selected.retrieval.issuerTracking = true as unknown as 'prevented'
    await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow()
    selected.retrieval.issuerTracking = 'prevented'
    selected.acceptedEvidence = ['independent-proof' as 'provider-assertion']
    await expect(evaluateBRC52Status(binary, selected)).rejects.toThrow()
  })
})
