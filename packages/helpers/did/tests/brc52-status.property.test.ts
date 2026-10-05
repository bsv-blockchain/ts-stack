import { jest } from '@jest/globals'
import fc from 'fast-check'
import { evaluateBRC52Status, type BRC52StatusPolicy } from '../src/brc52/status.js'
import { createSyntheticBRC52Binary } from './fixtures/brc52-synthetic.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})
jest.setTimeout(60_000)

const zeroTxid = '0'.repeat(64)

function statusPolicy(
  now: number,
  retrieve: BRC52StatusPolicy['retrieval']['retrieve']
): BRC52StatusPolicy {
  return {
    network: 'offline-synthetic',
    source: 'local-property-view',
    acceptedEvidence: ['provider-assertion'],
    maxAgeMs: 100,
    now,
    minConfirmations: 6,
    unconfirmedSpends: 'unknown',
    reorganization: 'require-stable',
    retrieval: {
      mode: 'local-chain-view',
      issuerTracking: 'prevented',
      protection: 'Offline test view; no query leaves the test process.',
      thirdPartyCorrelation: 'none',
      evidenceValidation: {
        kind: 'provider-assertion',
        procedure: 'Synthetic mock assertion only; no live chain proof validation.'
      },
      retrieve
    }
  }
}

function observation(
  outpoint: string,
  state: 'spent' | 'unspent',
  observedAt: number
): Record<string, unknown> {
  return {
    outpoint,
    network: 'offline-synthetic',
    source: 'local-property-view',
    observedAt,
    exists: true,
    state,
    confirmations: 6,
    reorganization: 'stable',
    evidence: { kind: 'provider-assertion', reference: 'offline-synthetic-observation' }
  }
}

describe('BRC-203 bounded status properties', () => {
  test('respects exact age/depth boundaries and the distinct unconfirmed-spend decision', async () => {
    const outpoint = `${zeroTxid}.1`
    const binary = createSyntheticBRC52Binary([], outpoint)
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('spent' as const, 'unspent' as const),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
        fc.boolean(),
        fc.constantFrom(-1, 0, 100, 101),
        async (state, confirmations, minimum, acceptUnconfirmedSpend, age) => {
          const received = { ...observation(outpoint, state, 1000 - age), confirmations }
          const selected = statusPolicy(1000, async () => received)
          selected.minConfirmations = minimum
          selected.unconfirmedSpends = acceptUnconfirmedSpend ? 'accept' : 'unknown'
          const result = await evaluateBRC52Status(binary, selected)
          const fresh = age >= 0 && age <= 100
          const unconfirmedSpend = state === 'spent' && confirmations === 0
          const depthAccepted = unconfirmedSpend ? acceptUnconfirmedSpend : confirmations >= minimum
          const expected =
            !fresh || !depthAccepted ? 'unknown' : state === 'spent' ? 'revoked' : 'notRevokedAsOf'
          expect(result.status).toBe(expected)
          if (!fresh) expect(result.reason).toBe('stale-observation')
          else if (!depthAccepted) expect(result.reason).toBe('chain-policy-insufficient')
          else expect(result.observedAt).toBe(1000 - age)
        }
      )
    )
  })

  test('evaluates signed sentinel/outpoints with only the minimal privacy-preserving query', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 252 })),
        fc.constantFrom('spent' as const, 'unspent' as const),
        fc.boolean(),
        fc.integer({ min: 1000, max: 10_000 }),
        async (vout, state, privacyAllowed, now) => {
          const outpoint = `${zeroTxid}.${vout}`
          const binary = createSyntheticBRC52Binary([], outpoint)
          const retrieve = jest.fn(
            async (query: Readonly<{ outpoint: string; network: string }>) => {
              expect(query).toEqual({ outpoint, network: 'offline-synthetic' })
              expect(Object.isFrozen(query)).toBe(true)
              return observation(outpoint, state, now - 10)
            }
          )
          const policy = statusPolicy(now, retrieve)
          if (!privacyAllowed) policy.retrieval.issuerTracking = 'possible'
          const result = await evaluateBRC52Status(binary, policy)
          if (vout === 0) {
            expect(result.status).toBe('disabled')
            expect(retrieve).not.toHaveBeenCalled()
          } else if (!privacyAllowed) {
            expect(result).toMatchObject({
              status: 'unknown',
              reason: 'issuer-tracking-prohibited'
            })
            expect(retrieve).not.toHaveBeenCalled()
          } else {
            expect(result.status).toBe(state === 'spent' ? 'revoked' : 'notRevokedAsOf')
            expect(result.evidence?.kind).toBe('provider-assertion')
            expect(retrieve).toHaveBeenCalledTimes(1)
          }
        }
      )
    )
  })

  test('fails closed for generated stale, nonexistent, mismatched or insufficient observations', async () => {
    const outpoint = `${zeroTxid}.1`
    const binary = createSyntheticBRC52Binary([], outpoint)
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          'stale',
          'missing',
          'network',
          'outpoint',
          'source',
          'evidence',
          'confirmations',
          'reorganization'
        ),
        fc.integer({ min: 1000, max: 10_000 }),
        async (failure, now) => {
          const received = observation(outpoint, 'unspent', now - 10)
          if (failure === 'stale') received.observedAt = now - 101
          else if (failure === 'missing') received.exists = false
          else if (failure === 'network') received.network = 'different-network'
          else if (failure === 'outpoint') received.outpoint = `${zeroTxid}.2`
          else if (failure === 'source') received.source = 'different-source'
          else if (failure === 'evidence')
            received.evidence = {
              kind: 'independently-validated-chain',
              reference: 'provider-label-alone'
            }
          else if (failure === 'confirmations') received.confirmations = 5
          else received.reorganization = 'conflicting'
          const policy = statusPolicy(now, async () => received)
          expect(await evaluateBRC52Status(binary, policy)).toMatchObject({ status: 'unknown' })
        }
      )
    )
  })
})
