import { describe, expect, it } from '@jest/globals'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import { ColorPlan, type ColorPlan as Plan } from '../ColorPlan.js'

const ASSET = `${'ab'.repeat(32)}_0`
const MAX_PLAN_BYTES = 16 * 1024 * 1024
const SENDER = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    version: 1,
    assets: [ASSET],
    ownedOutputs: [
      {
        outputIndex: 1,
        assetId: ASSET,
        derivationPrefix: 'AQ==',
        derivationSuffix: 'Ag==',
        senderIdentityKey: SENDER
      }
    ],
    operations: [{ assetId: ASSET, operation: 'transfer' }],
    inputPositions: [],
    changePositions: [],
    sighashTypes: [],
    ...overrides
  }
}

function labelsFor(json: string): string[] {
  const hex = toHex(toArray(json, 'utf8'))
  const count = Math.ceil(hex.length / 200)
  return Array.from(
    { length: count },
    (_, i) => `p color plan ${i} ${count} ${hex.slice(i * 200, (i + 1) * 200)}`
  )
}

describe('ColorPlan', () => {
  it('round-trips a plan through 200-hex-character label chunks among other labels', () => {
    const labels = ColorPlan.toLabels(plan())
    expect(labels.length).toBeGreaterThan(1)
    expect(labels.slice(0, -1).every(label => label.split(' ')[5].length === 200)).toBe(true)
    const shuffled = ['ordinary', ...labels.reverse(), 'admin originator app.example']
    expect(ColorPlan.fromLabels(shuffled)).toEqual(plan())
  })

  it('returns undefined when no plan labels are present', () => {
    expect(ColorPlan.fromLabels(['p nosend expiry seconds 30'])).toBeUndefined()
    expect(ColorPlan.fromLabels([])).toBeUndefined()
    expect(ColorPlan.fromLabels(undefined)).toBeUndefined()
  })

  it('accepts only plan version 1', () => {
    for (const version of [0, 2]) {
      const json = JSON.stringify({ ...plan(), version })
      expect(() => ColorPlan.fromLabels(labelsFor(json))).toThrow('BRC-207: plan version must be 1')
      expect(() => ColorPlan.toLabels({ ...plan(), version } as unknown as Plan)).toThrow(
        'BRC-207: plan version must be 1'
      )
    }
  })

  it.each([
    ['a duplicate part', (labels: string[]) => [...labels, labels[0]], 'duplicate plan part'],
    ['a missing part', (labels: string[]) => labels.slice(1), 'missing plan part'],
    [
      'inconsistent counts',
      (labels: string[]) => [labels[0].replace(/ (\d+) ([0-9a-f]+)$/, ' 9 $2'), ...labels.slice(1)],
      ''
    ],
    [
      'a short nonfinal chunk',
      (labels: string[]) => [labels[0].slice(0, -2), ...labels.slice(1)],
      'short nonfinal'
    ],
    [
      'uppercase hex',
      (labels: string[]) => [
        labels[0].replace(/[0-9a-f]+$/, hex => hex.toUpperCase()),
        ...labels.slice(1)
      ],
      'invalid p color plan label'
    ]
  ])('rejects %s', (_name, mutate, message) => {
    expect(() => ColorPlan.fromLabels(mutate(ColorPlan.toLabels(plan())))).toThrow(message)
  })

  it('rejects duplicate and unknown JSON members at every level', () => {
    const json = JSON.stringify(plan())
    expect(() =>
      ColorPlan.fromLabels(labelsFor(json.replace('"version":1', '"version":1,"version":1')))
    ).toThrow('duplicate member')
    expect(() =>
      ColorPlan.fromLabels(labelsFor(json.replace('"version":1', '"version":1,"inputTopics":[]')))
    ).toThrow('unknown member inputTopics')
    expect(() =>
      ColorPlan.fromLabels(
        labelsFor(json.replace('"outputIndex":1', '"outputIndex":1,"extra":true'))
      )
    ).toThrow('unknown member extra')
  })

  it('rejects plan contents that 207 forbids', () => {
    expect(() => ColorPlan.toLabels(plan({ assets: [ASSET, ASSET] }))).toThrow(
      'duplicate plan asset'
    )
    expect(() => ColorPlan.toLabels(plan({ assets: [] }))).toThrow('outside plan.assets')
    expect(() =>
      ColorPlan.toLabels(
        plan({ operations: [{ assetId: ASSET, operation: 'steal' as 'transfer' }] })
      )
    ).toThrow('unknown operation')
    expect(() =>
      ColorPlan.toLabels(
        plan({
          ownedOutputs: [
            {
              outputIndex: 0,
              assetId: ASSET,
              derivationPrefix: 'a b',
              derivationSuffix: 'x',
              senderIdentityKey: SENDER
            }
          ]
        })
      )
    ).toThrow('without whitespace')
    expect(() => ColorPlan.toLabels(plan({ assets: [`${'AB'.repeat(32)}_0`] }))).toThrow(
      'invalid asset ID'
    )
  })

  it('carries position constraints, signature overrides and profile data', () => {
    const outpoint = `${'cd'.repeat(32)}.1`
    const full = plan({
      inputPositions: [{ outpoint, index: 0 }],
      changePositions: [
        { assetId: ASSET, index: 2 },
        { assetId: null, index: 3 }
      ],
      sighashTypes: [{ outpoint, sighashType: 0x43 }],
      profileData: { 'https://example.com/profile': { [ASSET]: { anything: [1] }, ISSUE: null } }
    })
    expect(
      ColorPlan.fromLabels(
        ColorPlan.toLabels({
          ...full,
          assets: [ASSET, 'ISSUE'],
          operations: [...full.operations, { assetId: 'ISSUE', operation: 'deploy-fixed' }]
        })
      )
    ).toMatchObject({
      inputPositions: [{ outpoint, index: 0 }],
      sighashTypes: [{ outpoint, sighashType: 0x43 }]
    })
  })

  it('has no tokenProofs member; plan proofs travel in their own labels', () => {
    const json = JSON.stringify({ ...plan(), tokenProofs: [] })
    expect(() => ColorPlan.fromLabels(labelsFor(json))).toThrow('unknown member tokenProofs')
  })

  it.each([
    [
      'duplicate input outpoints',
      {
        inputPositions: [
          { outpoint: `${'cd'.repeat(32)}.1`, index: 0 },
          { outpoint: `${'cd'.repeat(32)}.1`, index: 1 }
        ]
      },
      'duplicate plan input position outpoint'
    ],
    [
      'duplicate change positions',
      {
        changePositions: [
          { assetId: null, index: 1 },
          { assetId: ASSET, index: 1 }
        ]
      },
      'duplicate plan change position index'
    ],
    [
      'a sighash type above 255',
      { sighashTypes: [{ outpoint: `${'cd'.repeat(32)}.1`, sighashType: 256 }] },
      '0..255'
    ],
    [
      'a profile entry for an invalid asset',
      { profileData: { 'https://example.com/p': { nope: 1 } } },
      'invalid asset ID'
    ],
    [
      'an ISSUE asset without a deploy operation',
      { assets: [ASSET, 'ISSUE'] },
      'exactly one deploy'
    ],
    [
      'duplicate remittance outputs',
      { ownedOutputs: [...plan().ownedOutputs, ...plan().ownedOutputs] },
      'output index'
    ]
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => ColorPlan.toLabels(plan(overrides as Partial<Plan>))).toThrow(message)
  })

  it('bounds part indices and counts before reassembly', () => {
    expect(() => ColorPlan.fromLabels(['p color plan 1 1 00'])).toThrow('out of range')
    for (const version of ['1.0', '1e0', '10E-1']) {
      const text = JSON.stringify(plan()).replace('"version":1', `"version":${version}`)
      expect(() => ColorPlan.fromLabels(labelsFor(text))).toThrow('fraction or exponent')
    }
    expect(() => ColorPlan.fromLabels(['p color plan 0 999999 00'])).toThrow('16 MiB')
    expect(() => ColorPlan.fromLabels(['p color plan 0 1 0'])).toThrow('invalid plan chunk')
    expect(() => ColorPlan.fromLabels(['p color plan x'])).toThrow('invalid p color plan label')
    expect(() => ColorPlan.fromLabels(labelsFor('{"version":2}'))).toThrow('missing')
  })

  // 16 MiB inputs are built from repeated strings, and every case is rejected before a full
  // JSON parse, so these stay fast and memory-bounded.
  it('refuses to encode a plan above 16 MiB of JSON, and bounds the size inclusively', () => {
    // A first member nested past the JSON depth limit fails the strict parse at once, so a
    // plan of exactly 16 MiB proves the size bound admitted it without parsing 16 MiB.
    const deep = JSON.parse(`${'['.repeat(70)}${']'.repeat(70)}`) as unknown
    const sized = (bytes: number): Plan => {
      const base = JSON.stringify({ deep, pad: '' }).length
      return { deep, pad: 'a'.repeat(bytes - base) } as unknown as Plan
    }
    expect(() => ColorPlan.toLabels(sized(MAX_PLAN_BYTES))).toThrow('nesting too deep')
    expect(() => ColorPlan.toLabels(sized(MAX_PLAN_BYTES + 1))).toThrow(
      'BRC-207: plan exceeds 16 MiB'
    )
  })

  it('refuses to reassemble labels above 16 MiB of hex, and bounds the size inclusively', () => {
    // The part-count cap rounds up, so a full final chunk overshoots 16 MiB by 84 bytes.
    const fullParts = Math.ceil((MAX_PLAN_BYTES * 2) / 200) - 1
    const labels = (finalChunk: string): string[] => {
      const count = fullParts + 1
      const chunk = 'ff'.repeat(100)
      return [
        ...Array.from({ length: fullParts }, (_, i) => `p color plan ${i} ${count} ${chunk}`),
        `p color plan ${fullParts} ${count} ${finalChunk}`
      ]
    }
    expect(() => ColorPlan.fromLabels(labels('ff'.repeat(100)))).toThrow(
      'BRC-207: plan exceeds 16 MiB'
    )
    // Exactly 16 MiB passes the size bound; 0xff bytes then fail strict UTF-8 decoding.
    const exact = labels('ff'.repeat(MAX_PLAN_BYTES - fullParts * 100))
    expect(exact.reduce((total, label) => total + label.split(' ')[5].length, 0)).toBe(
      MAX_PLAN_BYTES * 2
    )
    expect(() => ColorPlan.fromLabels(exact)).toThrow('BRC-207: plan is not strict UTF-8')
  })
})
