import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseOutputLookupOpen,
  parseOutputLookupRead,
  parseOutputLookupClose,
  parseOutputLookupBatch,
  validateOutputLookupContinuation,
  negotiateOutputLookupLimits,
  parseOutputObservation,
  parseOutputProposal,
  parseOutputCapabilities,
  selectOutputCapability,
  OUTPUT_PROFILES,
  canonicalOutputBase,
  outputEndpoint,
  outputPacketDigest,
  signOutputPacket,
  OutputProtocolError,
  type OutputCapabilityRequest
} from '../../../mod.js'
import PrivateKey from '../../primitives/PrivateKey.js'

// Selected unchanged objects from the BRCs 9dade70 independently checked corpus.
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/output-wire.json'), 'utf8'))
const snapshot = () => structuredClone(fixture.live.batch)
const live = () => structuredClone(fixture.live.live)
const manifest = () => structuredClone(fixture.capability)

describe('BRC-193 complete authenticated batch boundary', () => {
  it('accepts the frozen snapshot/live/proposal representations', () => {
    expect(parseOutputLookupOpen(fixture.live.open)).toEqual(fixture.live.open)
    expect(parseOutputLookupBatch(snapshot())).toEqual(snapshot())
    expect(parseOutputLookupBatch(live())).toEqual(live())
    expect(parseOutputLookupBatch(fixture.live.emptySnapshot)).toEqual(fixture.live.emptySnapshot)
    validateOutputLookupContinuation(
      parseOutputLookupBatch(snapshot()),
      parseOutputLookupBatch(live())
    )
    expect(parseOutputProposal(fixture.proposal)).toEqual(fixture.proposal)
    for (const observation of snapshot().groups[0].observations) {
      expect(parseOutputObservation(observation)).toEqual(observation)
    }
  })

  it('clamps requested limits explicitly and rejects invalid configurations', () => {
    const provider = { maxBytes: 100000, maxObservations: 10, waitMs: 500 }
    expect(
      negotiateOutputLookupLimits(
        { maxBytes: 4294967295, maxObservations: 4294967295, waitMs: 4294967295 },
        provider
      )
    ).toEqual(provider)
    expect(
      negotiateOutputLookupLimits(provider, {
        maxBytes: 4294967295,
        maxObservations: 4294967295,
        waitMs: 4294967295
      })
    ).toEqual(provider)
    expect(negotiateOutputLookupLimits({ ...provider, waitMs: 0 }, provider).waitMs).toBe(0)
    expect(() => negotiateOutputLookupLimits({ ...provider, maxBytes: 0 }, provider)).toThrow(
      'positive'
    )
    expect(() => negotiateOutputLookupLimits(provider, { ...provider, maxBytes: 65535 })).toThrow(
      '64 KiB'
    )
  })

  it('keeps empty and sparse live intervals distinct from snapshot boundaries', () => {
    const previous = parseOutputLookupBatch(snapshot())
    const empty = live()
    empty.groups = []
    empty.through = '20'
    empty.highWater = '20'
    validateOutputLookupContinuation(previous, parseOutputLookupBatch(empty))
    empty.phase = 'snapshot'
    expect(() => validateOutputLookupContinuation(previous, parseOutputLookupBatch(empty))).toThrow(
      'boundary'
    )
    const partial = snapshot()
    partial.snapshotComplete = false
    const final = snapshot()
    validateOutputLookupContinuation(parseOutputLookupBatch(partial), parseOutputLookupBatch(final))
    final.through = '11'
    final.groups = []
    expect(() =>
      validateOutputLookupContinuation(
        parseOutputLookupBatch(partial),
        parseOutputLookupBatch(final)
      )
    ).toThrow('boundary')
  })

  it.each([
    [
      'chain',
      (v: ReturnType<typeof snapshot>) => {
        v.groups[0].observations[0].scope.chain.genesisHash = '00'.repeat(32)
      }
    ],
    [
      'scope',
      (v: ReturnType<typeof snapshot>) => {
        v.groups[0].observations[0].scope.access = 'other'
      }
    ],
    [
      'closed nested object',
      (v: ReturnType<typeof snapshot>) => {
        v.groups[0].observations[0].scope.chain.extra = true
      }
    ],
    [
      'duplicate group',
      (v: ReturnType<typeof snapshot>) => {
        v.groups.push(v.groups[0])
      }
    ],
    [
      'duplicate observation',
      (v: ReturnType<typeof snapshot>) => {
        v.groups[0].observations.push(v.groups[0].observations[0])
      }
    ],
    [
      'beyond through',
      (v: ReturnType<typeof snapshot>) => {
        v.groups[0].sequence = '11'
      }
    ],
    [
      'wrong snapshot W',
      (v: ReturnType<typeof snapshot>) => {
        v.groups[0].sequence = '9'
      }
    ],
    [
      'unsafe integer',
      (v: ReturnType<typeof snapshot>) => {
        v.limits.maxBytes = 9007199254740992
      }
    ],
    [
      'byte bound',
      (v: ReturnType<typeof snapshot>) => {
        v.limits.maxBytes = 64
      }
    ],
    [
      'observation bound',
      (v: ReturnType<typeof snapshot>) => {
        v.limits.maxObservations = 0
      }
    ],
    [
      'through highWater',
      (v: ReturnType<typeof snapshot>) => {
        v.through = '13'
      }
    ],
    [
      'deadline',
      (v: ReturnType<typeof snapshot>) => {
        v.replayUntil = '1'
      }
    ]
  ])('rejects invalid %s without yielding an observation', (_name, change) => {
    const value = snapshot()
    change(value)
    expect(() => parseOutputLookupBatch(value)).toThrow(OutputProtocolError)
  })

  it('fences continued sessions, deadlines, epochs and watermark reversals', () => {
    const previous = parseOutputLookupBatch(snapshot())
    for (const patch of [
      { session: 'other' },
      { expiresAt: '1790611400' },
      { replayUntil: '1790612200' },
      { scope: { ...previous.scope, epoch: 'other' } },
      { through: '9' }
    ]) {
      expect(() =>
        validateOutputLookupContinuation(previous, { ...parseOutputLookupBatch(live()), ...patch })
      ).toThrow(OutputProtocolError)
    }
    const duplicate = live()
    duplicate.groups[0].sequence = previous.through
    expect(() =>
      validateOutputLookupContinuation(previous, parseOutputLookupBatch(duplicate))
    ).toThrow('incoming watermark')
  })

  it('parses read/close and rejects unsupported request extensions', () => {
    const request = {
      version: 1,
      session: 'session',
      cursor: 'cursor',
      limits: fixture.live.open.limits
    }
    expect(parseOutputLookupRead(request)).toEqual(request)
    expect(parseOutputLookupClose({ version: 1, session: 'session' })).toEqual({
      version: 1,
      session: 'session'
    })
    expect(() => parseOutputLookupRead({ ...request, credential: 'not a protocol field' })).toThrow(
      'Unknown'
    )
    const open = {
      ...fixture.live.open,
      extensions: { 'urn:future': true },
      critical: ['urn:future']
    }
    expect(() => parseOutputLookupOpen(open)).toThrow('Unsupported')
    expect(parseOutputLookupOpen(open, ['urn:future'])).toEqual(open)
  })
})

describe('BRC-194 endpoint and manifest selection', () => {
  it.each([
    ['https://EXAMPLE.test:443/api/', 'https://example.test/api'],
    ['https://example.test', 'https://example.test'],
    ['https://example.test:8443/a%20b', 'https://example.test:8443/a%20b'],
    ['https://[2001:0DB8:0:0::1]:8443/api', 'https://[2001:db8::1]:8443/api'],
    ['https://xn--bcher-kva.example/api', 'https://xn--bcher-kva.example/api'],
    ['https://example.test/café', 'https://example.test/caf%C3%A9']
  ])('canonicalizes %s before caller endpoint approval', (input, expected) => {
    expect(canonicalOutputBase(input)).toBe(expected)
    expect(outputEndpoint(input, '/overlay/v1/lookup/open')).toBe(
      expected + '/overlay/v1/lookup/open'
    )
  })

  it.each([
    'https://example.test./',
    'https://example.test/a/../b',
    'https://example.test/a%2Fb',
    'https://example.test/%2e/',
    'https://example.test/%25',
    'https://example.test/%00',
    'https://example.test/%41',
    'https://example.test/a//b',
    'https://example.test/%gg',
    'https://example.test/%',
    'https://example.test/?',
    'https://user@example.test/',
    'https://example.test\\evil',
    'https://b%C3%BCcher.test',
    'https://bücher.test',
    'https://127.1/',
    'https://example.test:foo',
    'ftp://example.test',
    'https://example.test/\ud800'
  ])('rejects ambiguous base %s', input => {
    expect(() => canonicalOutputBase(input)).toThrow(OutputProtocolError)
  })

  it('requires locally authorized HTTP and rejects arbitrary suffixes', () => {
    expect(() => canonicalOutputBase('http://localhost:8080/api')).toThrow('HTTPS')
    expect(canonicalOutputBase('http://localhost:8080/api', true)).toBe('http://localhost:8080/api')
    expect(() => outputEndpoint('https://example.test', '//other.test')).toThrow('suffix')
  })

  function selection(overrides: Partial<OutputCapabilityRequest> = {}): OutputCapabilityRequest {
    return {
      baseURL: fixture.capability.body.baseURL,
      identity: fixture.capability.body.identity,
      authenticatedPeer: fixture.capability.body.identity,
      chain: fixture.chain,
      kind: 'lookup',
      service: 'ls_catalogue',
      profile: OUTPUT_PROFILES.lookup,
      now: String(fixture.clock),
      maximumAgeSeconds: '300',
      clockSkewSeconds: '5',
      rules: new Map([
        [
          'urn:brc-fixture:catalogue-rules:1',
          parameters => {
            expect(parameters).toEqual({
              order: 'outpoint',
              visibility: 'authorized',
              selection: 'listing-descendants'
            })
          }
        ]
      ]),
      ...overrides
    }
  }

  it('verifies the signed frozen manifest and all six profile shapes', () => {
    expect(parseOutputCapabilities(manifest())).toEqual(manifest())
    const chosen = selectOutputCapability(manifest(), selection())
    expect(chosen.digest).toBe(outputPacketDigest('capabilities', fixture.capability.body))
    expect(chosen.headers['x-bsv-overlay-profile']).toBe(OUTPUT_PROFILES.lookup)
    expect(chosen.profile.payment).toBe('none')
  })

  it('never silently downgrades an absent or stale required selection', () => {
    for (const changes of [
      { service: 'absent' },
      { profile: 'urn:unknown' },
      { rules: new Map() },
      { now: fixture.capability.body.expiresAt },
      { now: String(fixture.clock - 20) },
      { now: String(fixture.clock + 301) },
      { baseURL: 'https://other.test/api' },
      { identity: new PrivateKey(1).toPublicKey().toString() },
      { authenticatedPeer: new PrivateKey(1).toPublicKey().toString() },
      { chain: { ...fixture.chain, network: 'main' } }
    ])
      expect(() => selectOutputCapability(manifest(), selection(changes))).toThrow(
        OutputProtocolError
      )
  })

  it('rejects parameter changes even when freshly signed by the selected host', () => {
    const key = new PrivateKey(71)
    const mutate = (update: (body: ReturnType<typeof manifest>['body']) => void) => {
      const body = manifest().body
      body.identity = key.toPublicKey().toString()
      update(body)
      return signOutputPacket('capabilities', body, key)
    }
    for (const update of [
      (body: ReturnType<typeof manifest>['body']) => {
        body.services.push(body.services[0])
      },
      (body: ReturnType<typeof manifest>['body']) => {
        body.services[0].profiles.push(body.services[0].profiles[0])
      },
      (body: ReturnType<typeof manifest>['body']) => {
        body.services[0].profiles[0].payment = 'brc105'
      },
      (body: ReturnType<typeof manifest>['body']) => {
        body.services[0].profiles[0].parameters.hidden = true
      },
      (body: ReturnType<typeof manifest>['body']) => {
        body.services[0].profiles[1].parameters.recoverySeconds = '86399'
      },
      (body: ReturnType<typeof manifest>['body']) => {
        body.services[0].rulesDigest = '00'.repeat(32)
      },
      (body: ReturnType<typeof manifest>['body']) => {
        body.services[1].profiles[0].parameters.policies[0].digest = '00'.repeat(32)
      },
      (body: ReturnType<typeof manifest>['body']) => {
        body.services[1].profiles[2].parameters.releasePolicies[2].confirmations = 0
      },
      (body: ReturnType<typeof manifest>['body']) => {
        body.services[2].name = 'wrong'
      }
    ])
      expect(() => parseOutputCapabilities(mutate(update))).toThrow(OutputProtocolError)
  })
})
