import { describe, expect, it } from '@jest/globals'
import { LockingScript } from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'
import { Bsv21Binary } from '@bsv/templates'
import { assertNoRequiredProfiles, readTokenOutput } from '../tokenOutputs.js'

const TXID = 'cd'.repeat(32)
const PKH = Array.from({ length: 20 }, (_, i) => i)
const text = (value: string): number[] => [0x60 + value.length, ...toArray(value, 'utf8')]

// DAG-CBOR maps, keys in length-first order.
const EMPTY_REQ = [0xa1, ...text('req'), 0xa0]
const DECLARED_REQ = [
  0xa1,
  ...text('req'),
  0xa1,
  ...text('x:y'),
  0xa2,
  ...text('params'),
  0xf6,
  ...text('version'),
  0x01
]
const DISPLAY_ONLY = [
  0xa3,
  ...text('dec'),
  0x08,
  ...text('sym'),
  ...text('GOLD'),
  ...text('icon'),
  0x82,
  0x69,
  ...toArray('image/png', 'utf8'),
  0x41,
  0x89
]

describe('BRC-162 token outputs', () => {
  it('reads value, authority and deploy roles with their asset IDs', () => {
    const template = new Bsv21Binary()
    expect(
      readTokenOutput(template.lock(`${TXID}_0`, 500n, PKH), { txid: '00'.repeat(32), vout: 3 })
    ).toEqual({
      assetId: `${TXID}_0`,
      role: 'value',
      amount: 500n,
      deploy: false,
      pubKeyHash: PKH
    })
    expect(
      readTokenOutput(template.lock(`${TXID}_0`, 0n, PKH), { txid: '00'.repeat(32), vout: 1 })?.role
    ).toBe('authority')
    expect(readTokenOutput(template.lock(null, 9n, PKH), { txid: TXID, vout: 0 })).toMatchObject({
      assetId: `${TXID}_0`,
      deploy: true,
      role: 'value'
    })
    expect(() => readTokenOutput(template.lock(null, 9n, PKH), { txid: TXID, vout: 1 })).toThrow(
      'output 0'
    )
    expect(
      readTokenOutput(LockingScript.fromASM('OP_TRUE'), { txid: TXID, vout: 0 })
    ).toBeUndefined()
  })

  it('accepts payloads that declare no required profiles, including display arrays and opaque bytes', () => {
    for (const payload of [
      undefined,
      [],
      [0xa0],
      EMPTY_REQ,
      DISPLAY_ONLY,
      [0x01, 0x02],
      [0xa1, 0x63]
    ]) {
      expect(() => assertNoRequiredProfiles(payload)).not.toThrow()
    }
  })

  it('fails an asset that requires a processing profile, or a malformed req', () => {
    expect(() => assertNoRequiredProfiles(DECLARED_REQ)).toThrow('requires processing profiles')
    expect(() => assertNoRequiredProfiles([0xa1, ...text('req'), 0x05])).toThrow('malformed req')
    expect(() =>
      readTokenOutput(new Bsv21Binary().lock(null, 9n, PKH, DECLARED_REQ), { txid: TXID, vout: 0 })
    ).toThrow('requires processing profiles')
  })

  it('treats noncanonical DAG-CBOR as an opaque payload', () => {
    // Keys out of length-first order are not a valid DAG-CBOR map, so `req` is not read.
    const unsorted = [0xa2, ...text('req'), 0xa1, ...text('x:y'), 0xf6, ...text('ab'), 0xf6]
    expect(() => assertNoRequiredProfiles(unsorted)).not.toThrow()
    // A non-minimal length argument is likewise invalid.
    expect(() =>
      assertNoRequiredProfiles([0xb8, 0x01, ...text('req'), 0xa1, ...text('x:y'), 0xf6])
    ).not.toThrow()
  })

  it('reads every DAG-CBOR value type in a payload without declared profiles', () => {
    const everyType = [
      0xa7,
      ...text('a'),
      0x20,
      ...text('b'),
      0x41,
      0x00,
      ...text('c'),
      0x81,
      0xfb,
      0x3f,
      0xf8,
      0,
      0,
      0,
      0,
      0,
      0,
      ...text('d'),
      0xf5,
      ...text('e'),
      0xf4,
      ...text('f'),
      0xf6,
      ...text('g'),
      0xd8,
      0x2a,
      0x42,
      0x00,
      0x01
    ]
    expect(() => assertNoRequiredProfiles(everyType)).not.toThrow()
    expect(() =>
      assertNoRequiredProfiles([0xa1, ...text('ext'), 0xa1, ...text('x:y'), 0x01])
    ).not.toThrow()
    expect(() => assertNoRequiredProfiles([0xa1, ...text('ext'), 0x05])).toThrow('malformed ext')
    expect(() =>
      assertNoRequiredProfiles([0xa1, ...text('ext'), 0xa1, ...text('bad'), 0x01])
    ).toThrow('invalid processing-profile identifier')
  })

  it.each([
    ['a half-precision float', [0xf9, 0x3c, 0x00]],
    ['a non-finite float', [0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0]],
    ['a tag other than 42', [0xc1, 0x01]],
    ['a CID without its multibase prefix', [0xd8, 0x2a, 0x41, 0x01]],
    ['an indefinite length', [0x5f, 0xff]],
    ['a non-minimal argument', [0x18, 0x05]],
    ['a length beyond the payload', [0x7a, 0xff, 0xff, 0xff, 0xff]],
    ['a truncated argument', [0x19, 0x01]],
    ['a reserved simple value', [0xf7]],
    ['excessive nesting', [...Array(70).fill(0x81), 0x01]]
  ])('treats a payload with %s as opaque, without reading its req', (_name, value) => {
    const payload = [0xa1, ...text('req'), 0xa1, ...text('x:y'), ...value]
    expect(() => assertNoRequiredProfiles(payload)).not.toThrow()
  })

  it('treats a map with a non-text key as opaque', () => {
    expect(() => assertNoRequiredProfiles([0xa1, 0x01, 0x01])).not.toThrow()
  })
})
