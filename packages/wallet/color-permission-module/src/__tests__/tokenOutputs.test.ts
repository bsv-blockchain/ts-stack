import { describe, expect, it } from '@jest/globals'
import { LockingScript, OP } from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'
import { OneColor, STRICT_CBOR_MAX_DEPTH } from '@bsv/templates'
import {
  assertNoRequiredProfiles,
  isDeployOutput,
  readAnyTokenOutput,
  readJsonTokenOutput,
  readTokenOutput,
  UnsupportedProfileError
} from '../tokenOutputs.js'
import { jsonTokenScript } from './fixtures.js'

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
    const template = new OneColor()
    expect(
      readTokenOutput(template.lock(`${TXID}_0`, 500n, PKH), { txid: '00'.repeat(32), vout: 3 })
    ).toEqual({
      assetId: `${TXID}_0`,
      role: 'value',
      amount: 500n,
      deploy: false,
      encoding: 'brc162',
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

  it('fails a token-shaped script whose prefix is not canonical BRC-162', () => {
    const valid = new OneColor().lock(`${TXID}_0`, 500n, PKH)
    const shortId = new LockingScript([
      { op: 31, data: Array(31).fill(0xcd) },
      ...valid.chunks.slice(1)
    ])
    expect(() => readTokenOutput(shortId, { txid: TXID, vout: 4 })).toThrow(
      `BRC-207: ${TXID}.4 is not a supported BRC-162 output (token id must be a direct 32- or 36-byte push)`
    )
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
    expect(() => assertNoRequiredProfiles(DECLARED_REQ)).toThrow(UnsupportedProfileError)
    expect(() => assertNoRequiredProfiles(DECLARED_REQ)).toThrow('requires processing profiles')
    expect(() => assertNoRequiredProfiles([0xa1, ...text('req'), 0x05])).toThrow('malformed req')
    expect(() =>
      readTokenOutput(new OneColor().lock(null, 9n, PKH, DECLARED_REQ), { txid: TXID, vout: 0 })
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
    ['excessive nesting', [...Array(STRICT_CBOR_MAX_DEPTH + 2).fill(0x81), 0x01]]
  ])('treats a payload with %s as opaque, without reading its req', (_name, value) => {
    const payload = [0xa1, ...text('req'), 0xa1, ...text('x:y'), ...value]
    expect(() => assertNoRequiredProfiles(payload)).not.toThrow()
  })

  it('treats a map with a non-text key as opaque', () => {
    expect(() => assertNoRequiredProfiles([0xa1, 0x01, 0x01])).not.toThrow()
  })
})

describe('BRC-161 JSON token outputs', () => {
  const ASSET = `${TXID}_1`
  const at = { txid: 'ab'.repeat(32), vout: 2 }

  it('reads transfers under any lock and deploy+mint at its own outpoint', () => {
    expect(
      readJsonTokenOutput(
        jsonTokenScript({ p: 'bsv-20', op: 'transfer', id: ASSET, amt: '25' }),
        at
      )
    ).toEqual({
      assetId: ASSET,
      role: 'value',
      amount: 25n,
      deploy: false,
      encoding: 'brc161',
      jsonOperation: 'transfer'
    })
    const deploy = jsonTokenScript({ p: 'bsv-20', op: 'deploy+mint', amt: '1000', sym: 'OLD' })
    expect(readJsonTokenOutput(deploy, at)).toMatchObject({
      assetId: `${at.txid}_2`,
      amount: 1000n,
      deploy: true
    })
    expect(isDeployOutput(deploy, at)).toBe(true)
  })

  it('reads an envelope placed after the lock, and a mint as value', () => {
    const p2pkh = LockingScript.fromHex(`76a914${'ab'.repeat(20)}88ac`)
    expect(
      readJsonTokenOutput(
        jsonTokenScript({ p: 'bsv-20', op: 'transfer', id: ASSET, amt: '25' }, p2pkh, false),
        at
      )
    ).toMatchObject({ assetId: ASSET, amount: 25n })
    expect(
      readJsonTokenOutput(jsonTokenScript({ p: 'bsv-20', op: 'mint', id: ASSET, amt: '5' }), at)
    ).toMatchObject({ role: 'value', amount: 5n, deploy: false, jsonOperation: 'mint' })
  })

  it('reads a non-inscription and a non-bsv-20 inscription as no JSON token', () => {
    expect(readJsonTokenOutput(LockingScript.fromASM('OP_TRUE'), at)).toBeUndefined()
    const text = new LockingScript()
      .writeOpCode(OP.OP_FALSE)
      .writeOpCode(OP.OP_IF)
      .writeBin(toArray('ord', 'utf8'))
      .writeOpCode(OP.OP_1)
      .writeBin(toArray('text/plain', 'utf8'))
      .writeOpCode(OP.OP_FALSE)
      .writeBin(toArray('hello', 'utf8'))
      .writeOpCode(OP.OP_ENDIF)
    expect(readJsonTokenOutput(text, at)).toBeUndefined()
  })

  it('reads auth and deploy+auth as authority outputs of no value', () => {
    expect(
      readJsonTokenOutput(jsonTokenScript({ p: 'bsv-20', op: 'auth', id: ASSET }), at)
    ).toEqual({
      assetId: ASSET,
      role: 'authority',
      amount: 0n,
      deploy: false,
      encoding: 'brc161',
      jsonOperation: 'auth'
    })
    expect(
      readJsonTokenOutput(jsonTokenScript({ p: 'bsv-20', op: 'deploy+auth' }), at)
    ).toMatchObject({ assetId: `${at.txid}_2`, role: 'authority', amount: 0n, deploy: true })
    expect(() =>
      readJsonTokenOutput(jsonTokenScript({ p: 'bsv-20', op: 'auth', id: ASSET, amt: '5' }), at)
    ).toThrow('malformed BRC-161 inscription')
  })

  it('fails an unterminated ord envelope as a malformed inscription', () => {
    const unterminated = new LockingScript()
      .writeOpCode(OP.OP_FALSE)
      .writeOpCode(OP.OP_IF)
      .writeBin(toArray('ord', 'utf8'))
      .writeOpCode(OP.OP_1)
    expect(() => readJsonTokenOutput(unterminated, at)).toThrow(
      `BRC-207: ${at.txid}.2 is a malformed BRC-161 inscription (not a BSV-21 script: unterminated ord envelope)`
    )
  })

  it.each(['transfer', 'mint', 'deploy+mint'])('fails a %s of amount zero', op => {
    expect(() =>
      readJsonTokenOutput(jsonTokenScript({ p: 'bsv-20', op, id: ASSET, amt: '0' }), at)
    ).toThrow(`BRC-207: ${at.txid}.2 is a malformed BRC-161 inscription (amt must be positive)`)
  })

  it('refuses the burn operation', () => {
    expect(() =>
      readJsonTokenOutput(jsonTokenScript({ p: 'bsv-20', op: 'burn', id: ASSET, amt: '5' }), at)
    ).toThrow('BRC-161 burn is an operation this module does not support')
  })

  it.each([
    ['an unknown op', { p: 'bsv-20', op: 'swap', id: ASSET, amt: '5' }],
    ['another protocol', { p: 'bsv-21', op: 'transfer', id: ASSET, amt: '5' }],
    ['a missing amount', { p: 'bsv-20', op: 'transfer', id: ASSET }],
    [
      'an amount above uint64',
      { p: 'bsv-20', op: 'transfer', id: ASSET, amt: '18446744073709551616' }
    ],
    ['an invalid token ID', { p: 'bsv-20', op: 'transfer', id: 'nope', amt: '5' }]
  ])('fails on a malformed inscription: %s', (_name, payload) => {
    expect(() => readJsonTokenOutput(jsonTokenScript(payload), at)).toThrow(
      'malformed BRC-161 inscription'
    )
  })

  it('reads a script that parses as both encodings as BRC-162', () => {
    const inscription = jsonTokenScript({ p: 'bsv-20', op: 'transfer', id: ASSET, amt: '7' })
    const both = new LockingScript([
      ...new OneColor().lock(`${TXID}_0`, 9n, PKH).chunks.slice(0, 3),
      ...inscription.chunks
    ])
    expect(readAnyTokenOutput(both, at)).toMatchObject({
      assetId: `${TXID}_0`,
      amount: 9n,
      encoding: 'brc162'
    })
  })
})
