import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  parseOutputRootEvictionRequest,
  parseOutputRootEvictionResult,
  parseOutputRootEvictionStatus,
  validateOutputRootEvictionWindow,
  verifyOutputRootEvictionRequest,
  verifyOutputRootEvictionResult,
  outputRootAdvertisementDigest,
  outputRootEvictionDecisionId,
  outputPacketDigest,
  signOutputPacket
} from '../../../mod.js'
import {
  rootRequestBody,
  signedRootRequest,
  rootResultBody,
  rootOutcome,
  requesterKey,
  rootKey,
  otherKey,
  rootPolicy,
  rootChain
} from './OutputRootEvictionProtocol.fixture.js'

const requestPacket = (body: unknown) => ({ body, signature: 'AA==' })
const resultPacket = (body: unknown) => ({ body, signature: 'AA==' })

const frozenBytes = readFileSync(resolve(__dirname, 'fixtures/root-eviction-wire.json'))
const frozen: {
  vectors: {
    id: string
    request: unknown
    policyDigest: string
    response: unknown
    expected: {
      requestDigest: string
      resultDigest: string
      advertisementDigest: string
      actionRevision: string
      decisionId: string | null
      affectedDecisionIds: string[]
      servingRevision: string
      blockers: { decisionId: string; policyDigest: string }[]
    }
  }[]
} = JSON.parse(frozenBytes.toString('utf8'))

test.each(frozen.vectors)('frozen cross-language wire vector $id', vector => {
  expect(createHash('sha256').update(frozenBytes).digest('hex')).toBe(
    'fcde42cc6fbeb2ef872206409c57d0410df17641a19453003828e15a7eb1ec4a'
  )
  const request = parseOutputRootEvictionRequest(vector.request)
  const verified = verifyOutputRootEvictionRequest(request, {
    root: rootKey.toPublicKey().toString(),
    chain: rootChain,
    requester: requesterKey.toPublicKey().toString()
  })
  const result = verifyOutputRootEvictionResult(vector.response, verified, vector.policyDigest)
  const outcome = result.body.outcomes[0]
  expect(outputPacketDigest('root-eviction-request', verified.body)).toBe(
    vector.expected.requestDigest
  )
  expect(outputPacketDigest('root-eviction-result', result.body)).toBe(vector.expected.resultDigest)
  expect(verified.body.targets[0].advertisementDigest).toBe(vector.expected.advertisementDigest)
  expect(outcome.revision).toBe(vector.expected.actionRevision)
  expect(outcome.decisionId ?? null).toBe(vector.expected.decisionId)
  expect(outcome.affectedDecisionIds).toEqual(vector.expected.affectedDecisionIds)
  expect(outcome.serving.revision).toBe(vector.expected.servingRevision)
  expect(outcome.serving.blockers).toEqual(vector.expected.blockers)
})

test('root requests own closed bounded packets and require canonical signed target order', () => {
  const body = rootRequestBody()
  const input = requestPacket(body)
  expect(parseOutputRootEvictionRequest(JSON.stringify(input))).toEqual(input)
  const parsed = parseOutputRootEvictionRequest(input)
  body.targets[0].advertisement.beef = 'AQ=='
  expect(parsed.body.targets[0].advertisement.beef).toBe('AA==')
  for (const changed of [
    { ...body, action: 'ban' },
    { ...body, requestId: 'short' },
    { ...body, targets: [] },
    { ...body, targets: Array.from({ length: 65 }, () => body.targets[0]) },
    { ...body, targets: [body.targets[0], body.targets[0]] },
    { ...body, privileged: true }
  ])
    expect(() => parseOutputRootEvictionRequest(requestPacket(changed))).toThrow()
  const last = { ...body.targets[0], service: 'ls_slap' }
  expect(
    parseOutputRootEvictionRequest(requestPacket({ ...body, targets: [body.targets[0], last] }))
      .body.targets
  ).toHaveLength(2)
  expect(() =>
    parseOutputRootEvictionRequest(requestPacket({ ...body, targets: [last, body.targets[0]] }))
  ).toThrow('sorted unique')
  expect(() =>
    parseOutputRootEvictionRequest({ ...input, signature: Buffer.alloc(175).toString('base64') })
  ).toThrow('limit')
  expect(() =>
    parseOutputRootEvictionRequest(
      requestPacket({
        ...body,
        targets: [
          {
            ...body.targets[0],
            advertisement: {
              ...body.targets[0].advertisement,
              beef: Buffer.alloc(800000).toString('base64')
            }
          }
        ]
      })
    )
  ).toThrow('byte limit')
})

test('each request binds chains, exact evidence selectors, restoration and all three evidence kinds', () => {
  const body = rootRequestBody(),
    target = body.targets[0]
  for (const patch of [
    { outpoint: { ...target.outpoint, chain: { ...rootChain, network: 'other' } } },
    { advertisement: { ...target.advertisement, txid: '33'.repeat(32) } },
    { advertisement: { ...target.advertisement, outputIndex: 1 } },
    { restores: '44'.repeat(32) },
    { advertisement: undefined },
    {
      evidence: {
        kind: 'owner-withdrawal',
        advertisement: { ...target.advertisement, outputIndex: 2 }
      }
    },
    {
      evidence: {
        kind: 'owner-withdrawal',
        advertisement: { ...target.advertisement, txid: '33'.repeat(32) }
      }
    },
    { evidence: { kind: 'unknown' } }
  ])
    expect(() =>
      parseOutputRootEvictionRequest(requestPacket({ ...body, targets: [{ ...target, ...patch }] }))
    ).toThrow()
  for (const evidence of [
    { kind: 'spent', txid: '44'.repeat(32), beef: 'AQ==' },
    { kind: 'owner-withdrawal', advertisement: { ...target.advertisement, beef: 'Ag==' } },
    target.evidence
  ])
    expect(
      parseOutputRootEvictionRequest(requestPacket({ ...body, targets: [{ ...target, evidence }] }))
        .body.targets[0].evidence
    ).toEqual(evidence)
  expect(() =>
    parseOutputRootEvictionRequest(requestPacket({ ...body, action: 'restore' }))
  ).toThrow('Restore')
  expect(
    parseOutputRootEvictionRequest(
      requestPacket({
        ...body,
        action: 'restore',
        targets: [{ ...target, restores: '44'.repeat(32) }]
      })
    ).body.action
  ).toBe('restore')
})

test('new-request clocks have exact expiry, finite selected lifetime and overflow-safe future allowance', () => {
  const body = rootRequestBody(),
    clock = { now: '100', maximumLifetimeSeconds: '100', futureClockSeconds: '0' }
  const valid = requestPacket(body)
  expect(validateOutputRootEvictionWindow(valid, clock)).toEqual(valid)
  for (const [issuedAt, expiresAt] of [
    ['100', '100'],
    ['100', '99'],
    ['100', '86501']
  ])
    expect(() =>
      parseOutputRootEvictionRequest(requestPacket({ ...body, issuedAt, expiresAt }))
    ).toThrow('lifetime')
  expect(
    parseOutputRootEvictionRequest(requestPacket({ ...body, expiresAt: '86500' })).body.expiresAt
  ).toBe('86500')
  for (const patch of [
    { now: '200' },
    { now: '99' },
    { maximumLifetimeSeconds: '99' },
    { maximumLifetimeSeconds: '0' },
    { maximumLifetimeSeconds: '86401' },
    { now: '01' }
  ])
    expect(() => validateOutputRootEvictionWindow(valid, { ...clock, ...patch })).toThrow()
  expect(
    validateOutputRootEvictionWindow(valid, { ...clock, now: '99', futureClockSeconds: '1' })
  ).toEqual(valid)
  expect(() =>
    validateOutputRootEvictionWindow(valid, { ...clock, now: '98', futureClockSeconds: '1' })
  ).toThrow('clock window')
  const upper = requestPacket({
    ...body,
    issuedAt: '18446744073709551614',
    expiresAt: '18446744073709551615'
  })
  expect(
    validateOutputRootEvictionWindow(upper, {
      ...clock,
      now: '18446744073709551614',
      futureClockSeconds: '2'
    })
  ).toEqual(upper)
  // Parsing a retained signed request does not reject it using today's clock.
  expect(parseOutputRootEvictionRequest(valid)).toEqual(valid)
})

test('direct requests authenticate selected root, chain and transport requester before any policy decision', () => {
  const packet = signedRootRequest()
  const selected = {
    root: packet.body.recipient,
    chain: rootChain,
    requester: packet.body.requester
  }
  expect(verifyOutputRootEvictionRequest(packet, selected)).toEqual(packet)
  for (const patch of [
    { root: otherKey.toPublicKey().toString() },
    { requester: otherKey.toPublicKey().toString() },
    { chain: { ...rootChain, genesisHash: '77'.repeat(32) } }
  ])
    expect(() => verifyOutputRootEvictionRequest(packet, { ...selected, ...patch })).toThrow(
      'selection'
    )
  expect(() =>
    verifyOutputRootEvictionRequest(
      signOutputPacket('root-eviction-request', packet.body, otherKey),
      selected
    )
  ).toThrow('signer')
  expect(() =>
    verifyOutputRootEvictionRequest(
      { ...packet, body: { ...packet.body, reason: 'changed' } },
      selected
    )
  ).toThrow('signature failed')
  expect(() =>
    verifyOutputRootEvictionRequest(
      signOutputPacket('root-eviction-result', packet.body, requesterKey),
      selected
    )
  ).toThrow('signature failed')
})

test('advertisement and decision identities bind complete bytes and root-local audit fields', () => {
  const request = rootRequestBody(),
    target = request.targets[0]
  const advertisement = {
    service: target.service,
    outpoint: target.outpoint,
    lockingScript: 'UQ=='
  }
  expect(outputRootAdvertisementDigest(advertisement)).toBe(
    outputPacketDigest('root-advertisement', advertisement)
  )
  for (const patch of [
    { service: 'ls_slap' as const },
    { lockingScript: 'Ug==' },
    { outpoint: { ...target.outpoint, outputIndex: 1 } }
  ])
    expect(outputRootAdvertisementDigest({ ...advertisement, ...patch })).not.toBe(
      target.advertisementDigest
    )
  expect(() => outputRootAdvertisementDigest({ ...advertisement, lockingScript: 'AB==' })).toThrow(
    'padding'
  )
  const decision = {
    root: request.recipient,
    requestDigest: outputPacketDigest('root-eviction-request', request),
    service: target.service,
    outpoint: target.outpoint,
    revision: '1'
  }
  expect(outputRootEvictionDecisionId(decision)).toBe(
    outputPacketDigest('root-eviction-decision', decision)
  )
  for (const patch of [
    { root: otherKey.toPublicKey().toString() },
    { requestDigest: '44'.repeat(32) },
    { service: 'ls_slap' as const },
    { outpoint: { ...target.outpoint, outputIndex: 1 } },
    { revision: '2' }
  ])
    expect(outputRootEvictionDecisionId({ ...decision, ...patch })).not.toBe(
      rootOutcome(request).decisionId
    )
  expect(() =>
    outputRootEvictionDecisionId({ ...decision, revision: '18446744073709551616' })
  ).toThrow('overflow')
})

test('status is closed and does not confer authority', () => {
  const query = {
    version: 1,
    requester: requesterKey.toPublicKey().toString(),
    requestId: 'root_request_fixture_1'
  }
  expect(parseOutputRootEvictionStatus(query)).toEqual(query)
  expect(() => parseOutputRootEvictionStatus({ ...query, auditor: true })).toThrow('Unknown')
  expect(() => parseOutputRootEvictionStatus({ ...query, requestId: 'short' })).toThrow(
    'request ID'
  )
})

test('result schemas separate immutable actions, affected bases and current sorted blocking decisions', () => {
  const body = rootResultBody(),
    outcome = body.outcomes[0]
  const packet = resultPacket(body)
  expect(parseOutputRootEvictionResult(JSON.stringify(packet))).toEqual(packet)
  const parsed = parseOutputRootEvictionResult(packet)
  body.outcomes[0].reasonCode = 'changed'
  expect(parsed.body.outcomes[0].reasonCode).toBe('fixture-approved')
  for (const patch of [
    { decisionId: undefined },
    { affectedDecisionIds: [] },
    { actionStatus: 'pending' },
    { actionStatus: 'no-op' },
    { affectedDecisionIds: ['11'.repeat(32), '22'.repeat(32)] },
    { serving: { ...outcome.serving, state: 'eligible' } },
    { serving: { ...outcome.serving, blockers: [] } },
    {
      serving: {
        ...outcome.serving,
        blockers: [
          { decisionId: '22'.repeat(32), policyDigest: rootPolicy },
          { decisionId: '11'.repeat(32), policyDigest: rootPolicy }
        ]
      }
    },
    {
      serving: {
        ...outcome.serving,
        blockers: [outcome.serving.blockers[0], outcome.serving.blockers[0]]
      }
    }
  ])
    expect(() =>
      parseOutputRootEvictionResult(resultPacket({ ...body, outcomes: [{ ...outcome, ...patch }] }))
    ).toThrow()
  for (const actionStatus of ['pending', 'rejected']) {
    const { decisionId: _id, ...value } = outcome
    const changed = {
      ...value,
      actionStatus,
      affectedDecisionIds: [],
      serving: { state: 'unresolved', revision: '0', blockers: [] }
    }
    expect(
      parseOutputRootEvictionResult(resultPacket({ ...body, outcomes: [changed] })).body.outcomes[0]
    ).toEqual(changed)
    expect(() =>
      parseOutputRootEvictionResult(
        resultPacket({
          ...body,
          outcomes: [{ ...changed, affectedDecisionIds: ['11'.repeat(32)] }]
        })
      )
    ).toThrow('affected-decision')
  }
  expect(() => parseOutputRootEvictionResult(resultPacket({ ...body, outcomes: [] }))).toThrow(
    'bounds'
  )
  expect(() =>
    parseOutputRootEvictionResult(resultPacket({ ...body, outcomes: [outcome, outcome] }))
  ).toThrow('sorted unique')
})

test('signed results bind every target, its decision revision, retained evaluation policy and original request', () => {
  const original = signedRootRequest(),
    body = rootResultBody(original.body)
  const signed = signOutputPacket('root-eviction-result', body, rootKey)
  expect(verifyOutputRootEvictionResult(signed, original, rootPolicy)).toEqual(signed)
  const item = body.outcomes[0]
  for (const patch of [
    { root: otherKey.toPublicKey().toString() },
    { requestDigest: '33'.repeat(32) },
    { policyDigest: '44'.repeat(32) },
    { outcomes: [{ ...item, service: 'ls_slap' }] },
    {
      outcomes: [
        { ...item, outpoint: { ...item.outpoint, chain: { ...rootChain, network: 'other' } } }
      ]
    },
    { outcomes: [{ ...item, outpoint: { ...item.outpoint, txid: '22'.repeat(32) } }] },
    { outcomes: [{ ...item, outpoint: { ...item.outpoint, outputIndex: 1 } }] },
    { outcomes: [{ ...item, decisionId: '66'.repeat(32) }] },
    { outcomes: [{ ...item, revision: '2' }] },
    { outcomes: [{ ...item, affectedDecisionIds: ['66'.repeat(32)] }] },
    { outcomes: [item, { ...item, service: 'ls_slap' }] }
  ])
    expect(() =>
      verifyOutputRootEvictionResult(
        signOutputPacket('root-eviction-result', { ...body, ...patch }, rootKey),
        original,
        rootPolicy
      )
    ).toThrow()
  expect(() => verifyOutputRootEvictionResult(signed, original, '44'.repeat(32))).toThrow(
    'retained'
  )
  expect(() =>
    verifyOutputRootEvictionResult(
      signed,
      { ...original, body: { ...original.body, reason: 'changed' } },
      rootPolicy
    )
  ).toThrow('Original root request signature')
  expect(() =>
    verifyOutputRootEvictionResult(
      signOutputPacket('root-eviction-request', body, rootKey),
      original,
      rootPolicy
    )
  ).toThrow('Root result signature')
  expect(() =>
    verifyOutputRootEvictionResult(
      signOutputPacket('root-eviction-result', body, otherKey),
      original,
      rootPolicy
    )
  ).toThrow('signer')
})

test('restoring one basis can remain suppressed and replay keeps the action while refreshing serving', () => {
  const originalBody = rootRequestBody()
  originalBody.action = 'restore'
  originalBody.targets[0].restores = '11'.repeat(32)
  const original = signedRootRequest(originalBody),
    body = rootResultBody(originalBody)
  const item = body.outcomes[0]
  item.serving = {
    state: 'suppressed',
    revision: '2',
    blockers: [{ decisionId: '22'.repeat(32), policyDigest: '33'.repeat(32) }]
  }
  const verify = (value: unknown) =>
    verifyOutputRootEvictionResult(
      signOutputPacket('root-eviction-result', value, rootKey),
      original,
      rootPolicy
    )
  expect(verify(body).body.outcomes[0].affectedDecisionIds).toEqual(['11'.repeat(32)])
  const refreshed = {
    ...body,
    issuedAt: '300',
    outcomes: [{ ...item, serving: { state: 'eligible', revision: '3', blockers: [] } }]
  }
  expect(verify(refreshed).body.outcomes[0].decisionId).toBe(item.decisionId)
  expect(verify(refreshed).body.outcomes[0].revision).toBe('1')
  expect(() =>
    verify({ ...body, outcomes: [{ ...item, affectedDecisionIds: ['22'.repeat(32)] }] })
  ).toThrow('different suppression')
  const { decisionId: _id, ...withoutId } = item
  const noOp = { ...body, outcomes: [{ ...withoutId, actionStatus: 'no-op' }] }
  expect(verify(noOp).body.outcomes[0].actionStatus).toBe('no-op')
  expect(() =>
    verify({
      ...noOp,
      outcomes: [{ ...withoutId, actionStatus: 'no-op', affectedDecisionIds: ['22'.repeat(32)] }]
    })
  ).toThrow('named basis')
  const suppress = signedRootRequest(),
    suppressResult = rootResultBody(suppress.body)
  expect(() =>
    verifyOutputRootEvictionResult(
      signOutputPacket(
        'root-eviction-result',
        { ...suppressResult, outcomes: [{ ...withoutId, actionStatus: 'no-op' }] },
        rootKey
      ),
      suppress,
      rootPolicy
    )
  ).toThrow('Only restoration')
})

test('pending results cannot bypass original root, digest, full target count or exact target binding', () => {
  const request = rootRequestBody()
  request.targets.push({ ...request.targets[0], service: 'ls_slap' })
  const original = signedRootRequest(request),
    body = rootResultBody(request)
  body.outcomes = body.outcomes.map(({ decisionId: _id, ...item }) => ({
    ...item,
    actionStatus: 'pending',
    affectedDecisionIds: []
  }))
  const verify = (value: unknown, signer = rootKey) =>
    verifyOutputRootEvictionResult(
      signOutputPacket('root-eviction-result', value, signer),
      original,
      rootPolicy
    )
  expect(verify(body).body.outcomes).toHaveLength(2)
  expect(() => verify({ ...body, requestDigest: '33'.repeat(32) })).toThrow('retained request')
  expect(() => verify({ ...body, root: otherKey.toPublicKey().toString() }, otherKey)).toThrow(
    'retained request'
  )
  expect(() => verify({ ...body, outcomes: body.outcomes.slice(0, 1) })).toThrow('retained request')
  const patches = [
    { service: 'ls_slap' },
    { outpoint: { ...body.outcomes[0].outpoint, outputIndex: 1 } },
    { outpoint: { ...body.outcomes[0].outpoint, txid: '22'.repeat(32) } },
    { outpoint: { ...body.outcomes[0].outpoint, chain: { ...rootChain, network: 'other' } } }
  ]
  // Use one target so a changed service does not first fail duplicate ordering.
  const single = signedRootRequest(),
    singleBody = { ...rootResultBody(single.body), outcomes: [body.outcomes[0]] }
  for (const patch of patches)
    expect(() =>
      verifyOutputRootEvictionResult(
        signOutputPacket(
          'root-eviction-result',
          { ...singleBody, outcomes: [{ ...singleBody.outcomes[0], ...patch }] },
          rootKey
        ),
        single,
        rootPolicy
      )
    ).toThrow('changed a requested target')
})

test('multiple independent sorted blockers remain valid and selected lifetime includes its upper bound', () => {
  const body = rootResultBody(),
    item = body.outcomes[0]
  item.serving.blockers = [
    { decisionId: '11'.repeat(32), policyDigest: '33'.repeat(32) },
    { decisionId: '22'.repeat(32), policyDigest: '44'.repeat(32) }
  ]
  expect(
    parseOutputRootEvictionResult(resultPacket(body)).body.outcomes[0].serving.blockers
  ).toEqual(item.serving.blockers)
  const request = requestPacket({ ...rootRequestBody(), expiresAt: '86500' })
  const clock = { now: '100', maximumLifetimeSeconds: '86400', futureClockSeconds: '0' }
  expect(validateOutputRootEvictionWindow(request, clock)).toEqual(request)
  expect(() =>
    validateOutputRootEvictionWindow(request, { ...clock, maximumLifetimeSeconds: '0' })
  ).toThrow('Invalid selected root request lifetime')
})

test('authentication failures retain the unauthorized error identity', () => {
  const original = signedRootRequest()
  const selected = {
    root: original.body.recipient,
    chain: rootChain,
    requester: original.body.requester
  }
  const result = signOutputPacket('root-eviction-result', rootResultBody(original.body), rootKey)
  const failures = [
    () =>
      verifyOutputRootEvictionRequest(original, {
        ...selected,
        root: otherKey.toPublicKey().toString()
      }),
    () =>
      verifyOutputRootEvictionRequest(
        { ...original, body: { ...original.body, reason: 'changed' } },
        selected
      ),
    () =>
      verifyOutputRootEvictionResult(
        result,
        { ...original, body: { ...original.body, reason: 'changed' } },
        rootPolicy
      ),
    () =>
      verifyOutputRootEvictionResult(
        { ...result, body: { ...result.body, issuedAt: '151' } },
        original,
        rootPolicy
      )
  ]
  for (const run of failures) {
    let error: unknown
    try {
      run()
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'unauthorized' })
  }
})
