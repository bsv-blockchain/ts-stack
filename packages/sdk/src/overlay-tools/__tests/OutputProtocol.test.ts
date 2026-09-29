import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  canonicalOutputJSON,
  parseOutputJSON,
  OutputProtocolError,
  outputU64,
  incrementOutputU64,
  outputU32,
  outputString,
  outputHex32,
  outputIdentity,
  decodeOutputBytes,
  closedOutputObject,
  validateOutputExtensions,
  outputPacketPreimage,
  outputPacketDigest,
  OUTPUT_DIGEST_DOMAINS,
  signOutputPacket,
  verifyOutputPacket,
  type OutputDigestDomain
} from '../../../mod.js'
import PrivateKey from '../../primitives/PrivateKey.js'
import { toHex, toBase64 } from '../../primitives/utils.js'
import * as SignedMessage from '../../messages/SignedMessage.js'

describe('BRC-192 representation boundary', () => {
  // Unmodified independent Python digest corpus from BRCs 9dade70.
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, 'fixtures/output-digests.json'), 'utf8')
  )

  it('matches every registered independently generated digest and UTF-16 JCS ordering', () => {
    expect(fixture.vectors.map((v: { domain: string }) => v.domain)).toEqual(OUTPUT_DIGEST_DOMAINS)
    expect(canonicalOutputJSON(fixture.body)).toBe(fixture.canonical)
    for (const vector of fixture.vectors) {
      expect(toHex(outputPacketPreimage(vector.domain, fixture.body))).toBe(vector.preimage)
      expect(outputPacketDigest(vector.domain, fixture.body)).toBe(vector.sha256)
    }
  })

  it('normalizes integer spellings without imposing a canonical input spelling', () => {
    const parsed = parseOutputJSON('{"z":-0,"a":1.0,"b":1e0,"nil":null,"t":true,"f":false}')
    expect(canonicalOutputJSON(parsed)).toBe('{"a":1,"b":1,"f":false,"nil":null,"t":true,"z":0}')
    expect(parseOutputJSON(new TextEncoder().encode(' [ "é😀", {}, [] ] '))).toEqual([
      'é😀',
      {},
      []
    ])
    expect(parseOutputJSON('{"__proto__":{"x":1}}')).toHaveProperty('__proto__.x', 1)
    const foreign: unknown = runInNewContext('({scope: {epoch:"one"}, groups:[]})')
    expect(canonicalOutputJSON(foreign)).toBe('{"groups":[],"scope":{"epoch":"one"}}')
  })

  it.each([
    '{"a":1,"\\u0061":2}',
    '{"nested":{"x":1,"x":2}}',
    '"\\ud800"',
    '"\\udfff"',
    '"\ud800"',
    '\ufeff{}',
    '[1,]',
    '{"a":1,}',
    '01',
    '1e',
    'truefalse',
    '+1',
    'NaN',
    'Infinity',
    '0.5',
    '9007199254740992',
    '1e309',
    '"unterminated',
    '"bad\\x"',
    '"bad\n"',
    '',
    '{} trailing',
    '[',
    '{',
    '{1:2}',
    '{"a" 2}',
    '[1 2]'
  ])('rejects invalid protocol JSON %j', value => {
    expect(() => parseOutputJSON(value)).toThrow(OutputProtocolError)
  })

  it('rejects malformed UTF-8 and enforces limits before nested allocation', () => {
    expect(() => parseOutputJSON(Uint8Array.of(0xc0, 0xaf))).toThrow('UTF-8')
    expect(() => parseOutputJSON('"😀"', { bytes: 5 })).toThrow('byte limit')
    expect(() => parseOutputJSON('12345', { bytes: 4 })).toThrow('byte limit')
    expect(() => parseOutputJSON(new Uint8Array(9), { bytes: 8 })).toThrow('byte limit')
    expect(() => parseOutputJSON('[[0]]', { depth: 2 })).toThrow('depth')
    expect(() => parseOutputJSON('[0,1]', { arrayElements: 1 })).toThrow('array limit')
    expect(() => parseOutputJSON('{"a":0,"b":1}', { mapKeys: 1 })).toThrow('map limit')
    for (const bytes of [0, -1, Infinity, 4194305, 0.5]) {
      expect(() => parseOutputJSON('{}', { bytes })).toThrow('resource limit')
    }
  })

  it('rejects non-JSON values without invoking getters or toJSON', () => {
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    const sparse: unknown[] = []
    sparse.length = 2
    const getter = jest.fn(() => 1)
    const accessor = Object.defineProperty({}, 'x', { get: getter, enumerable: true })
    const hidden = Object.defineProperty({}, 'x', { value: 1 })
    const array = Object.defineProperty([1], '0', { get: getter })
    for (const value of [
      undefined,
      1n,
      Symbol('x'),
      NaN,
      Infinity,
      0.5,
      new Date(),
      new Uint8Array(1),
      cyclic,
      accessor,
      hidden,
      array,
      sparse,
      { [Symbol('k')]: 1 },
      { toJSON: () => ({}) }
    ]) {
      expect(() => canonicalOutputJSON(value)).toThrow(OutputProtocolError)
    }
    expect(getter).not.toHaveBeenCalled()
    expect(() => canonicalOutputJSON('long', { bytes: 3 })).toThrow('byte limit')
    expect(() => canonicalOutputJSON('é', { bytes: 3 })).toThrow('byte limit')
    expect(() => canonicalOutputJSON([0, 1], { arrayElements: 1 })).toThrow('array limit')
    expect(() => canonicalOutputJSON({ a: 0, b: 1 }, { mapKeys: 1 })).toThrow('map limit')
    expect(() => canonicalOutputJSON([[0]], { depth: 2 })).toThrow('depth')
    expect(() => canonicalOutputJSON('\udfff')).toThrow('surrogate')
  })

  it('uses exact checked unsigned arithmetic', () => {
    expect(outputU64('18446744073709551615')).toBe(18446744073709551615n)
    expect(incrementOutputU64('9007199254740991')).toBe('9007199254740992')
    expect(() => incrementOutputU64('18446744073709551615')).toThrow('exhausted')
    for (const value of [0, '', '00', '-1', '+1', '1.0', '1e0', '18446744073709551616']) {
      expect(() => outputU64(value)).toThrow('U64')
    }
    expect(outputU32(0xffffffff)).toBe(0xffffffff)
    for (const value of [-1, 4294967296, 0.5, '0', null])
      expect(() => outputU32(value)).toThrow('U32')
  })

  it('validates textual encodings and point membership', () => {
    expect(outputHex32('ab'.repeat(32))).toBe('ab'.repeat(32))
    expect(() => outputHex32('AB'.repeat(32))).toThrow('Hex32')
    expect(outputString('é'.repeat(512))).toHaveLength(512)
    for (const value of ['', 'é'.repeat(513), 'a'.repeat(1025), '\udfff', null]) {
      expect(() => outputString(value)).toThrow(OutputProtocolError)
    }
    const identity = new PrivateKey(42).toPublicKey().toString()
    expect(outputIdentity(identity)).toBe(identity)
    for (const value of [
      identity.toUpperCase(),
      '04' + '00'.repeat(32),
      '02' + 'ff'.repeat(32),
      '02' + '00'.repeat(32)
    ]) {
      expect(() => outputIdentity(value)).toThrow(OutputProtocolError)
    }
    expect(decodeOutputBytes('')).toEqual([])
    expect(decodeOutputBytes('YQ==')).toEqual([97])
    expect(decodeOutputBytes('YWI=')).toEqual([97, 98])
    expect(decodeOutputBytes('YWJj')).toEqual([97, 98, 99])
    for (const value of ['YQ', 'YR==', 'YWJ=', 'YQ===', ' YQ==', '-_==', null]) {
      expect(() => decodeOutputBytes(value)).toThrow(OutputProtocolError)
    }
    expect(() => decodeOutputBytes('YWJj', 1)).toThrow('byte limit')
    expect(() => decodeOutputBytes('YQ==', 0)).toThrow('byte limit')
    expect(() => decodeOutputBytes('', -1)).toThrow('byte limit')
  })

  it('closes nested schemas and handles optional and critical extensions separately', () => {
    closedOutputObject({ a: 1, b: 2 }, ['a'], ['b'])
    expect(() => closedOutputObject([], [])).toThrow('object')
    expect(() => closedOutputObject({ b: 1 }, ['a'])).toThrow('Missing')
    expect(() => closedOutputObject({ a: 1, b: 2 }, ['a'])).toThrow('Unknown')
    validateOutputExtensions({})
    validateOutputExtensions({ extensions: { 'urn:example:optional': 1 } })
    const extension = {
      extensions: { 'urn:example:required': null },
      critical: ['urn:example:required']
    }
    validateOutputExtensions(extension, ['urn:example:required'])
    expect(() => validateOutputExtensions(extension)).toThrow('Unsupported')
    expect(() => validateOutputExtensions({ critical: ['urn:missing'] })).toThrow('Missing')
    expect(() => validateOutputExtensions({ critical: ['urn:x', 'urn:x'] })).toThrow('Duplicate')
    expect(() => validateOutputExtensions({ extensions: { relative: 1 } })).toThrow('IRI')
  })

  it('binds BRC-77 packets to the intended role, digest domain and exact body', () => {
    const key = new PrivateKey(42)
    const identity = key.toPublicKey().toString()
    const body = { identity, sequence: '0', extensions: { 'urn:example:future': 'retained' } }
    const packet = signOutputPacket('capabilities', body, key)
    body.sequence = '1'
    expect(packet.body.sequence).toBe('0')
    expect(verifyOutputPacket('capabilities', packet, identity)).toBe(true)
    expect(verifyOutputPacket('proposal', packet, identity)).toBe(false)
    expect(verifyOutputPacket('capabilities', { ...packet, body }, identity)).toBe(false)
    expect(() =>
      verifyOutputPacket('capabilities', packet, new PrivateKey(43).toPublicKey().toString())
    ).toThrow('signer')
    const privateSignature = toBase64(
      SignedMessage.sign(
        outputPacketPreimage('capabilities', body),
        key,
        new PrivateKey(43).toPublicKey()
      )
    )
    expect(() =>
      verifyOutputPacket('capabilities', { body, signature: privateSignature }, identity)
    ).toThrow('anyone')
    expect(() => outputPacketDigest('unregistered' as OutputDigestDomain, {})).toThrow(
      'Unregistered'
    )
  })
})
