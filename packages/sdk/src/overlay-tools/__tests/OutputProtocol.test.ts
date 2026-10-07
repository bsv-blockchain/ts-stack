import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  canonicalOutputJSON,
  parseOutputJSON,
  inspectOutputJSONEncoding,
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
import { OUTPUT_JSON_LIMITS } from '../OutputProtocolJSON.js'

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

  it('inspects canonical encoding against independent literals and the existing Python corpus', () => {
    const cases: [string, string][] = [
      ['null', 'null'],
      ['true', 'true'],
      ['false', 'false'],
      ['0', '0'],
      ['-0', '0'],
      ['1.00', '1'],
      ['1e9', '1000000000'],
      ['100e-2', '1'],
      ['-9007199254740991', '-9007199254740991'],
      [' [] ', '[]'],
      ['{}', '{}'],
      ['[\r\ntrue,\tfalse, null, -0 ]', '[true,false,null,0]'],
      ['{"b":2,"a":1}', '{"a":1,"b":2}'],
      ['{"10":1,"2":2}', '{"10":1,"2":2}'],
      ['{"2":2,"10":1}', '{"10":1,"2":2}'],
      ['{"a":{"z":0,"b":1}}', '{"a":{"b":1,"z":0}}'],
      ['{"a":{},"b":[],"c":"é😀"}', '{"a":{},"b":[],"c":"é😀"}'],
      ['"\\u0061"', '"a"'],
      ['"\\/"', '"/"'],
      ['"\\u000a"', '"\\n"'],
      ['"\\u0000"', '"\\u0000"'],
      ['"\\u000F"', '"\\u000f"'],
      ['"\\ud83d\\ude00"', '"😀"'],
      ['"\\\\"', '"\\\\"'],
      ['"\\\""', '"\\\""'],
      ['" space "', '" space "'],
      [fixture.canonical, fixture.canonical]
    ]
    const encoder = new TextEncoder()
    for (const [source, canonical] of cases) {
      for (const input of [source, encoder.encode(source)]) {
        const inspected = inspectOutputJSONEncoding(input)
        expect(inspected.value).toEqual(JSON.parse(source))
        expect(inspected.canonical).toBe(source === canonical)
        expect(canonicalOutputJSON(inspected.value)).toBe(canonical)
      }
    }
    for (let code = 0; code < 128; code++) {
      for (const text of [
        String.fromCharCode(code),
        'prefix' + String.fromCharCode(code) + 'suffix'
      ]) {
        const source = JSON.stringify(text)
        expect(inspectOutputJSONEncoding(source)).toEqual({ value: text, canonical: true })
      }
    }
    for (const text of ['é', '😀', '\u2028', '\u2029', 'é'.repeat(2048)]) {
      const source = JSON.stringify(text),
        bytes = encoder.encode(source).length
      expect(inspectOutputJSONEncoding(source, { bytes })).toEqual({ value: text, canonical: true })
      expect(() => inspectOutputJSONEncoding(source, { bytes: bytes - 1 })).toThrow('byte limit')
    }
  })

  it('retains full parsing before canonical-size refusal and returns independently owned mutable values', () => {
    expect(inspectOutputJSONEncoding).toHaveLength(1)
    const encoder = new TextEncoder()
    for (const source of [
      '[1e9,"\\u0061"]',
      ' [1e9,"\\u0061"] ',
      '[1e15,"\\ud83d\\ude00",1e15,"\\/"]',
      '{"\\u0061":1e9}',
      '{ "a" : 1e9, "b" : "\\u000a" }'
    ]) {
      const value = JSON.parse(source),
        canonical = JSON.stringify(value),
        originalBytes = encoder.encode(source).length,
        canonicalBytes = encoder.encode(canonical).length,
        bytes = Math.max(originalBytes, canonicalBytes)
      for (const input of [source, encoder.encode(source)]) {
        expect(inspectOutputJSONEncoding(input, { bytes })).toEqual({
          value,
          canonical: source === canonical
        })
        expect(() => inspectOutputJSONEncoding(input, { bytes: bytes - 1 })).toThrow(
          'Output JSON byte limit'
        )
      }
    }
    expect(inspectOutputJSONEncoding('1e9', { bytes: 10 })).toEqual({
      value: 1000000000,
      canonical: false
    })
    expect(() => inspectOutputJSONEncoding('1e9', { bytes: 9 })).toThrow('Output JSON byte limit')
    expect(() => inspectOutputJSONEncoding('{"a":1e9,"a":0}', { bytes: 17 })).toThrow(
      'Duplicate decoded JSON key'
    )
    expect(() => inspectOutputJSONEncoding('[1e9,?]', { bytes: 7 })).toThrow('Invalid JSON token')
    expect(() => inspectOutputJSONEncoding('[[1e9]]', { depth: 2 })).toThrow('JSON depth limit')
    expect(() => inspectOutputJSONEncoding('[1e9,0]', { arrayElements: 1 })).toThrow(
      'JSON array limit'
    )
    expect(() => inspectOutputJSONEncoding('{"a":1e9,"b":0}', { mapKeys: 1 })).toThrow(
      'JSON map limit'
    )
    const source = '{"__proto__":{"x":[1]},"constructor":2}',
      first = inspectOutputJSONEncoding(source),
      second = inspectOutputJSONEncoding(source)
    const value = first.value as { __proto__: { x: number[] }; extra?: number }
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')).toEqual({
      value: { x: [1] },
      writable: true,
      enumerable: true,
      configurable: true
    })
    value.__proto__.x[0] = 9
    value.extra = 3
    expect(second.value).toEqual(JSON.parse(source))
    expect(first.canonical).toBe(true)
    expect(second.canonical).toBe(true)
  })

  it('preserves the original malformed-input and resource refusal identities during encoding inspection', () => {
    const cases: [Uint8Array | string, Parameters<typeof parseOutputJSON>[1]][] = [
      ['', undefined],
      ['0 trailing', undefined],
      ['{"a":1,}', undefined],
      ['[0,]', undefined],
      ['{"a" 1}', undefined],
      ['{"a":1 "b":2}', undefined],
      ['[0 1]', undefined],
      ['"\\x"', undefined],
      ['"\\ud800"', undefined],
      ['"\udfff"', undefined],
      ['"unfinished', undefined],
      ['0.5', undefined],
      ['9007199254740992', undefined],
      ['{"a":0,"\\u0061":1}', undefined],
      ['\ufeff{}', undefined],
      [Uint8Array.of(0xc0, 0xaf), undefined],
      [Uint8Array.of(0xef, 0xbb, 0xbf, 0x30), undefined],
      ['"😀"', { bytes: 5 }],
      ['{}', { bytes: 1 }],
      ['{}', { bytes: 0 }],
      ['{}', { depth: 33 }],
      ['{}', { mapKeys: 257 }],
      ['{}', { arrayElements: 4097 }]
    ]
    function refusal(work: () => unknown): {
      name: string
      message: string
      code: OutputProtocolError['code']
    } {
      try {
        work()
      } catch (error) {
        expect(error).toBeInstanceOf(OutputProtocolError)
        const failure = error as OutputProtocolError
        return { name: failure.name, message: failure.message, code: failure.code }
      }
      throw new Error('Expected independent parser refusal')
    }
    for (const [input, limits] of cases) {
      expect(refusal(() => inspectOutputJSONEncoding(input, limits))).toEqual(
        refusal(() => parseOutputJSON(input, limits))
      )
    }
  })

  it('bounds the decoded byte extent independently while retaining ordinary parser behavior and refusal ordering', () => {
    const encoder = new TextEncoder()
    const bytes = encoder.encode(' 0 ')
    Object.defineProperty(bytes, 'byteLength', { value: 1 })
    expect(parseOutputJSON(bytes, { bytes: 1 })).toBe(0)
    expect(() => inspectOutputJSONEncoding(bytes, { bytes: 1 })).toThrow(
      expect.objectContaining({ code: 'limited', message: 'Output JSON byte limit' })
    )
    expect(inspectOutputJSONEncoding(bytes, { bytes: 3 })).toEqual({ value: 0, canonical: false })
    const malformed = encoder.encode('[0,?]')
    Object.defineProperty(malformed, 'byteLength', { value: 1 })
    expect(() => inspectOutputJSONEncoding(malformed, { bytes: 1 })).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Invalid JSON token' })
    )
  })

  it('retains owned public arrays and independently hashed bytes for every digest domain', () => {
    const bodies = [
      null,
      { content: 'é😀\0\n', array: [false, 0, null], z: 'last', a: 'first' },
      { content: 'A'.repeat(65536) }
    ]
    for (const body of bodies) {
      const canonical = canonicalOutputJSON(body)
      for (const domain of OUTPUT_DIGEST_DOMAINS) {
        const bytes = new TextEncoder().encode(`BRC-OUTPUT/1/${domain}\0${canonical}`),
          digest = createHash('sha256').update(bytes).digest('hex'),
          first = outputPacketPreimage(domain, body),
          second = outputPacketPreimage(domain, body)
        expect(Array.isArray(first)).toBe(true)
        expect(first).toEqual(Array.from(bytes))
        expect(second).toEqual(first)
        expect(second).not.toBe(first)
        first[0] ^= 255
        expect(second).toEqual(Array.from(bytes))
        expect(outputPacketDigest(domain, body)).toBe(digest)
      }
    }
  })

  it('preserves domain-first validation and canonical body failures for both digest paths', () => {
    let reads = 0
    const accessor = Object.defineProperty({}, 'body', {
      enumerable: true,
      get() {
        reads++
        return 'not read'
      }
    })
    for (const operation of [outputPacketPreimage, outputPacketDigest]) {
      expect(() => operation('unregistered' as OutputDigestDomain, accessor)).toThrow(
        expect.objectContaining({
          code: 'unsupported',
          message: 'Unregistered output digest domain'
        })
      )
      expect(reads).toBe(0)
      expect(() => operation('purchase-request', accessor)).toThrow(OutputProtocolError)
      expect(reads).toBe(0)
      for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, BigInt(1)])
        expect(() => operation('purchase-request', invalid)).toThrow(OutputProtocolError)
    }
  })

  it('preserves independently encoded long strings, escape parity and exact UTF-8 fences', () => {
    for (let slashes = 0; slashes <= 32; slashes++) {
      const text = 'A'.repeat(16384) + '\\'.repeat(slashes) + '"é😀\n\0end',
        encoded = JSON.stringify(text),
        size = new TextEncoder().encode(encoded).length
      expect(parseOutputJSON(encoded, { bytes: size })).toBe(JSON.parse(encoded))
      expect(parseOutputJSON(new TextEncoder().encode(encoded), { bytes: size })).toBe(text)
      expect(canonicalOutputJSON(text, { bytes: size })).toBe(encoded)
      expect(() => parseOutputJSON(encoded, { bytes: size - 1 })).toThrow(
        expect.objectContaining({ code: 'limited', message: 'Output JSON byte limit' })
      )
    }
  })

  it('matches independent JSON escaping for every ASCII code unit and exact encoded fences', () => {
    const values = ['', 'A'.repeat(65536), ' !#[]^~', 'é😀\u2028\u2029', 'A\u2028', 'A\u2029']
    for (let code = 0; code < 128; code++) {
      const unit = String.fromCharCode(code)
      values.push(unit, 'left' + unit, unit + 'right', 'left' + unit + 'right')
    }
    for (const text of values) {
      for (const value of [text, { a: text, m: [text, null, false, -0], z: text }]) {
        const encoded = JSON.stringify(value),
          bytes = new TextEncoder().encode(encoded).length
        expect(canonicalOutputJSON(value, { bytes })).toBe(encoded)
        expect(() => canonicalOutputJSON(value, { bytes: bytes - 1 })).toThrow(
          expect.objectContaining({ code: 'limited', message: 'Output JSON byte limit' })
        )
      }
    }
  })

  it('keeps initial length and Unicode refusal ordering before ASCII serialization', () => {
    for (const text of ['\ud800', '\udfff', 'valid\ud800tail', '\udfffvalid']) {
      expect(() => canonicalOutputJSON(text)).toThrow(
        expect.objectContaining({ code: 'invalid', message: 'Unpaired JSON surrogate' })
      )
      if (text.length > 1)
        expect(() => canonicalOutputJSON(text, { bytes: text.length - 1 })).toThrow(
          expect.objectContaining({ code: 'limited', message: 'Output JSON byte limit' })
        )
    }
  })

  it('verifies independently signed long UTF-8 packets before and after mathematical reuse', () => {
    const key = new PrivateKey(179),
      identity = key.toPublicKey().toString(),
      body = { a: 'A'.repeat(8192), z: 'é😀\n"\\' },
      preimage = Array.from(
        new TextEncoder().encode('BRC-OUTPUT/1/purchase-terms\0' + JSON.stringify(body))
      ),
      packet = { body, signature: toBase64(SignedMessage.sign(preimage, key)) }
    for (let attempt = 0; attempt < 2; attempt++)
      expect(verifyOutputPacket('purchase-terms', structuredClone(packet), identity)).toBe(true)
    expect(
      verifyOutputPacket(
        'purchase-terms',
        { ...packet, body: { ...body, a: body.a + 'B' } },
        identity
      )
    ).toBe(false)
    let reads = 0
    const accessor = Object.defineProperty({}, 'a', {
      enumerable: true,
      get() {
        reads++
        return body.a
      }
    })
    expect(() =>
      verifyOutputPacket('purchase-terms', { ...packet, body: accessor }, identity)
    ).toThrow(OutputProtocolError)
    expect(reads).toBe(0)
    expect(verifyOutputPacket('purchase-terms', packet, identity)).toBe(true)
  })

  it('retains duplicate decoded-key checks through differently escaped delimiters and Unicode', () => {
    for (const key of ['quote"', 'backslash\\', 'control\n', 'é😀', 'A'.repeat(16384)]) {
      const escaped =
          '"' +
          key
            .split('')
            .map(unit => String.raw`\u` + unit.charCodeAt(0).toString(16).padStart(4, '0'))
            .join('') +
          '"',
        body = '{' + JSON.stringify(key) + ':1,' + escaped + ':2}'
      expect(() => parseOutputJSON(body)).toThrow(
        expect.objectContaining({ code: 'invalid', message: 'Duplicate decoded JSON key' })
      )
    }
  })

  it('preserves exact string refusal errors for long raw controls and unfinished escape runs', () => {
    const prefix = 'A'.repeat(16384)
    for (let code = 0; code < 32; code++)
      expect(() => parseOutputJSON('"' + prefix + String.fromCharCode(code) + '"')).toThrow(
        expect.objectContaining({ code: 'invalid', message: 'Malformed JSON string' })
      )
    for (let slashes = 0; slashes <= 32; slashes++) {
      const unfinished = '"' + prefix + '\\'.repeat(slashes)
      expect(() => parseOutputJSON(unfinished)).toThrow(
        expect.objectContaining({ code: 'invalid', message: 'Unterminated JSON string' })
      )
      if (slashes % 2 === 1)
        expect(() => parseOutputJSON(unfinished + '"')).toThrow(
          expect.objectContaining({ code: 'invalid', message: 'Unterminated JSON string' })
        )
    }
  })

  it('preserves explicit limits, their one-time reads and default function arity', () => {
    expect(parseOutputJSON).toHaveLength(1)
    expect(canonicalOutputJSON).toHaveLength(1)
    expect(Object.isFrozen(OUTPUT_JSON_LIMITS)).toBe(true)
    expect(OUTPUT_JSON_LIMITS).toEqual({
      bytes: 4194304,
      depth: 32,
      arrayElements: 4096,
      mapKeys: 256
    })
    expect(parseOutputJSON('{"a":1}', OUTPUT_JSON_LIMITS)).toEqual({ a: 1 })
    expect(canonicalOutputJSON({ a: 1 }, OUTPUT_JSON_LIMITS)).toBe('{"a":1}')
    let reads = 0
    const limits = {
      get bytes() {
        reads++
        return 7
      }
    }
    expect(parseOutputJSON('{"a":1}', limits)).toEqual({ a: 1 })
    expect(reads).toBe(1)
    expect(canonicalOutputJSON({ a: 1 }, limits)).toBe('{"a":1}')
    expect(reads).toBe(2)
    expect(() => parseOutputJSON('[1,2]', { arrayElements: 1 })).toThrow('JSON array limit')
    expect(() => parseOutputJSON('{"a":1,"b":2}', { mapKeys: 1 })).toThrow('JSON map limit')
    expect(() => parseOutputJSON('{"a":{"b":1}}', { depth: 2 })).toThrow('JSON depth limit')
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

  it('retains ordinary own-data attributes and a null prototype for decoded maps', () => {
    const parsed = parseOutputJSON('{"constructor":1,"prototype":2,"entry":3}') as Record<
      string,
      unknown
    >
    expect(Object.getPrototypeOf(parsed)).toBeNull()
    for (const [key, value] of Object.entries(parsed))
      expect(Object.getOwnPropertyDescriptor(parsed, key)).toEqual({
        value,
        enumerable: true,
        configurable: true,
        writable: true
      })
    parsed.entry = 4
    expect(canonicalOutputJSON(parsed)).toBe('{"constructor":1,"entry":4,"prototype":2}')
    delete parsed.entry
    expect(Object.keys(parsed)).toEqual(['constructor', 'prototype'])
  })

  it.each([
    ['12345', { bytes: 4 }, 'Output JSON byte limit'],
    ['"é"', { bytes: 3 }, 'Output JSON byte limit'],
    [new TextEncoder().encode('null '), { bytes: 4 }, 'Output JSON byte limit'],
    [new TextEncoder().encode('\ufeff{}'), {}, 'JSON BOM is not permitted'],
    [Uint8Array.of(0xc0, 0xaf), {}, 'Malformed UTF-8'],
    [123, {}, 'Expected UTF-8 bytes'],
    ['0 trailing', {}, 'Trailing JSON data'],
    ['{1:2}', {}, 'Expected JSON string'],
    ['"bad\\x"', {}, 'Malformed JSON string'],
    ['"unfinished', {}, 'Unterminated JSON string'],
    ['{"a":1,"a":2}', {}, 'Duplicate decoded JSON key'],
    ['{"a":1,"b":2}', { mapKeys: 1 }, 'JSON map limit'],
    ['{"a" 1}', {}, 'Expected JSON colon'],
    ['{"a":1 "b":2}', {}, 'Expected JSON object separator'],
    ['[1,2]', { arrayElements: 1 }, 'JSON array limit'],
    ['[1 2]', {}, 'Expected JSON array separator'],
    ['{"a":{"b":1}}', { depth: 2 }, 'JSON depth limit'],
    ['?1', {}, 'Invalid JSON token'],
    ['1e-1', {}, 'Protocol numbers must be safe integers']
  ])('preserves actionable parsing diagnostics for %j', (value, limits, reason) => {
    expect(() => parseOutputJSON(value as string, limits as { bytes: number })).toThrow(
      reason as string
    )
  })

  it('accepts exact structural and byte bounds including exponent and decimal spellings', () => {
    expect(parseOutputJSON(Uint8Array.of(0x30), { bytes: 1 })).toBe(0)
    expect(parseOutputJSON('{"a":1}', { mapKeys: 1, depth: 2 })).toEqual({ a: 1 })
    expect(parseOutputJSON('[1]', { arrayElements: 1, depth: 2 })).toEqual([1])
    expect(parseOutputJSON('[1.00,1e+10,100e-2]')).toEqual([1, 10000000000, 1])
    expect(canonicalOutputJSON([1], { arrayElements: 1, depth: 2 })).toBe('[1]')
    expect(canonicalOutputJSON({ a: 1 }, { mapKeys: 1, depth: 2 })).toBe('{"a":1}')
    expect(() => canonicalOutputJSON({ a: { b: 1 } }, { depth: 2 })).toThrow('JSON depth limit')
    expect(() => canonicalOutputJSON([1, 2], { arrayElements: 1 })).toThrow('JSON array limit')
    expect(() => canonicalOutputJSON({ a: 1, b: 2 }, { mapKeys: 1 })).toThrow('JSON map limit')
  })

  it('reports unsupported values and accessors without invoking application code', () => {
    const getter = jest.fn(() => 1)
    const array = [1]
    Object.defineProperty(array, 0, { get: getter, enumerable: true })
    expect(() => canonicalOutputJSON(array)).toThrow('JSON array accessor or hole')
    expect(getter).not.toHaveBeenCalled()
    expect(() =>
      canonicalOutputJSON(Object.defineProperty({}, 'a', { get: getter, enumerable: true }))
    ).toThrow('JSON accessor or hidden key')
    expect(() => canonicalOutputJSON(new Date(0))).toThrow('Expected plain JSON object')
    const sparse: number[] = []
    sparse[1] = 1
    expect(() => canonicalOutputJSON(sparse)).toThrow('Sparse or decorated JSON array')
    expect(() => canonicalOutputJSON({ [Symbol('key')]: 1 })).toThrow('Symbol JSON key')
    expect(() => canonicalOutputJSON(undefined)).toThrow('Expected a JSON value')
    expect(() => canonicalOutputJSON(0.5)).toThrow('Protocol numbers must be safe integers')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalOutputJSON(cyclic)).toThrow('Cyclic JSON value')
    expect(getter).not.toHaveBeenCalled()
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
      Object.defineProperty([1], 'hidden', { value: 'ignored' }),
      Object.defineProperty([1], '0', { value: 1, enumerable: false }),
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

  it('rechecks representations and exact signatures after repeated successful verification', () => {
    const key = new PrivateKey(176),
      identity = key.toPublicKey().toString()
    const packet = signOutputPacket('purchase-terms', { version: 1, recipient: identity }, key)
    for (let attempt = 0; attempt < 3; attempt++)
      expect(verifyOutputPacket('purchase-terms', structuredClone(packet), identity)).toBe(true)
    expect(verifyOutputPacket('potatoes', packet, identity)).toBe(false)
    expect(
      verifyOutputPacket(
        'purchase-terms',
        { ...packet, body: { ...packet.body, version: 2 } },
        identity
      )
    ).toBe(false)
    const different = signOutputPacket('purchase-terms', { ...packet.body, version: 2 }, key)
    expect(
      verifyOutputPacket('purchase-terms', { ...packet, signature: different.signature }, identity)
    ).toBe(false)
    expect(() =>
      verifyOutputPacket('purchase-terms', { ...packet, extra: true } as never, identity)
    ).toThrow('Unknown')
    const hidden = Object.defineProperty({ ...packet }, 'hidden', { value: true })
    expect(() => verifyOutputPacket('purchase-terms', hidden, identity)).toThrow()
    expect(() =>
      verifyOutputPacket(
        'purchase-terms',
        { ...packet, signature: packet.signature + 'AAAA' },
        identity
      )
    ).toThrow()
    expect(() => verifyOutputPacket('purchase-terms', packet, identity.toUpperCase())).toThrow()
    expect(() =>
      verifyOutputPacket('purchase-terms', packet, new PrivateKey(177).toPublicKey().toString())
    ).toThrow('signer')
    expect(verifyOutputPacket('purchase-terms', packet, identity)).toBe(true)
  })

  it('preserves exact verification after more than a bounded cache of unrelated facts', () => {
    const key = new PrivateKey(178),
      identity = key.toPublicKey().toString(),
      original = signOutputPacket('purchase-terms', { version: 1, sequence: 0 }, key)
    expect(verifyOutputPacket('purchase-terms', original, identity)).toBe(true)
    for (let sequence = 1; sequence <= 257; sequence++) {
      const other = new PrivateKey(sequence + 1000).toPublicKey().toString()
      expect(outputIdentity(other)).toBe(other)
      const packet = signOutputPacket('purchase-terms', { version: 1, sequence }, key)
      expect(verifyOutputPacket('purchase-terms', packet, identity)).toBe(true)
    }
    expect(outputIdentity(identity)).toBe(identity)
    expect(verifyOutputPacket('purchase-terms', original, identity)).toBe(true)
    expect(
      verifyOutputPacket(
        'purchase-terms',
        { ...original, body: { version: 1, sequence: 1 } },
        identity
      )
    ).toBe(false)
    expect(() => outputIdentity('02' + 'ff'.repeat(32))).toThrow()
  })

  it('captures partial limits once and rejects every invalid supplied override', () => {
    let reads = 0
    const limits = Object.defineProperty({}, 'bytes', {
      enumerable: true,
      get() {
        reads++
        return 4
      }
    })
    expect(parseOutputJSON('"é"', limits)).toBe('é')
    expect(reads).toBe(1)
    expect(canonicalOutputJSON('é', limits)).toBe('"é"')
    expect(reads).toBe(2)
    expect(inspectOutputJSONEncoding('"é"', limits).canonical).toBe(true)
    expect(reads).toBe(3)
    for (const invalid of [
      { bytes: undefined },
      { depth: null },
      { bytes: 0 },
      { bytes: OUTPUT_JSON_LIMITS.bytes + 1 },
      { arrayElements: 4097 },
      { mapKeys: 257 },
      { depth: 33 },
      { bytes: 4, unexpected: 1 }
    ])
      expect(() => parseOutputJSON('"é"', invalid as never)).toThrow(
        'Invalid output JSON resource limit'
      )
  })

  it('keeps the exact object colon byte boundary ahead of value refusal', () => {
    expect(() => canonicalOutputJSON({ a: undefined }, { bytes: 4 })).toThrow(
      'Output JSON byte limit'
    )
    expect(() => canonicalOutputJSON({ a: undefined }, { bytes: 5 })).toThrow(
      'Expected a JSON value'
    )
    expect(() => canonicalOutputJSON({ é: undefined }, { bytes: 5 })).toThrow(
      'Output JSON byte limit'
    )
    expect(() => canonicalOutputJSON({ é: undefined }, { bytes: 6 })).toThrow(
      'Expected a JSON value'
    )
    expect(canonicalOutputJSON({ a: 0 }, { bytes: 7 })).toBe('{"a":0}')
    expect(() => canonicalOutputJSON({ a: 0 }, { bytes: 6 })).toThrow('Output JSON byte limit')
  })

  it('preserves string decoding and cursor boundaries against independent literals', () => {
    const cases: [string, string, boolean][] = [
      ['""', '', true],
      ['"plain é😀"', 'plain é😀', true],
      ['"\\\"\\\\\\/\\b\\f\\n\\r\\t"', '"\\/\b\f\n\r\t', false],
      ['"\\u0061\\u0000\\ud83d\\ude00"', 'a\0😀', false],
      ['"\\\\u0061"', '\\u0061', true],
      ['"line\\nend"', 'line\nend', true]
    ]
    for (const [text, value, canonical] of cases) {
      expect(parseOutputJSON(text)).toBe(value)
      expect(inspectOutputJSONEncoding(text)).toEqual({ value, canonical })
      expect(parseOutputJSON(`[${text},"next",0]`)).toEqual([value, 'next', 0])
      const object = parseOutputJSON(`{"key":${text},"next":0}`)
      expect(object).toEqual({ key: value, next: 0 })
      expect(Object.getPrototypeOf(object)).toBeNull()
    }
    expect(() => parseOutputJSON('"a""b"')).toThrow('Trailing JSON data')
    expect(() => parseOutputJSON('{"a":0,"\\u0061":1}')).toThrow('Duplicate decoded JSON key')
  })

  it('retains malformed versus unterminated string refusals for every raw control', () => {
    for (const control of Array.from({ length: 32 }, (_, code) => String.fromCharCode(code))) {
      for (const read of [parseOutputJSON, inspectOutputJSONEncoding]) {
        expect(() => read('"before' + control + 'after"')).toThrow('Malformed JSON string')
        expect(() => read('"before\\' + control + 'after"')).toThrow('Malformed JSON string')
        expect(() => read('"before' + control + 'after')).toThrow('Unterminated JSON string')
      }
    }
    for (const read of [parseOutputJSON, inspectOutputJSONEncoding]) {
      for (const text of ['"\\q"', '"\\u12"', '"\\uZZZZ"'])
        expect(() => read(text)).toThrow('Malformed JSON string')
      for (const text of ['"', '"\\', '"\\"', '"\\u12'])
        expect(() => read(text)).toThrow('Unterminated JSON string')
      for (const text of ['"\\ud800"', '"\\udfff"', '"\\ud83dX\\ude00"'])
        expect(() => read(text)).toThrow('Unpaired JSON surrogate')
    }
  })

  it('bounds maximum-size ordinary, escaped and unterminated string tokens', () => {
    const maximum = OUTPUT_JSON_LIMITS.bytes,
      plain = 'x'.repeat(maximum - 2),
      plainText = '"' + plain + '"',
      repetitions = (maximum - 2) / 2,
      escapedText = '"' + '\\\\'.repeat(repetitions) + '"',
      escaped = '\\'.repeat(repetitions),
      unterminated = '"' + '\\\\'.repeat(repetitions) + '\\'
    expect(parseOutputJSON(plainText)).toBe(plain)
    expect(inspectOutputJSONEncoding(plainText)).toEqual({ value: plain, canonical: true })
    expect(parseOutputJSON(escapedText)).toBe(escaped)
    expect(inspectOutputJSONEncoding(escapedText)).toEqual({ value: escaped, canonical: true })
    for (const read of [parseOutputJSON, inspectOutputJSONEncoding]) {
      expect(() => read('"' + 'x'.repeat(maximum - 1) + '"')).toThrow('Output JSON byte limit')
      expect(() => read(unterminated)).toThrow('Unterminated JSON string')
      expect(() => read('"' + 'x'.repeat(maximum - 3) + '\n"')).toThrow('Malformed JSON string')
    }
  })
})
