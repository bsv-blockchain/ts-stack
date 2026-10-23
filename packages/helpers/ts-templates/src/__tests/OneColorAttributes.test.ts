import { LockingScript, OP, P2PKH } from '@bsv/sdk'
import type { ScriptChunk } from '@bsv/sdk'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import {
  isProfileId,
  needsEmptyPayloadMarker,
  readOneColorAttributes,
  reqMatchesDeploy
} from '../OneColorAttributes.js'
import type { OneColorField } from '../OneColorAttributes.js'
import { encodeStrictCbor, StrictCborLink } from '../strictCbor.js'
import { OneColor } from '../OneColor.js'

const hex = (h: string): Uint8Array => Uint8Array.from(toArray(h.replace(/\s/g, ''), 'hex'))
const cbor = (m: Parameters<typeof encodeStrictCbor>[0]): number[] => encodeStrictCbor(m)
const ABSENT = { status: 'absent' }
const valid = <T>(f: OneColorField<T>): T => {
  if (f.status !== 'valid') throw new Error(`expected a valid field, got ${JSON.stringify(f)}`)
  return f.value
}

// BRC-207 A.141a deploy locking scripts (pinned 0207, "The actual deploy locking scripts are"), verbatim.
const FIXTURE = {
  U: '00596d33a163726571a1781975726e3a6578616d706c653a636f6c6f723a756e6b6e6f776ea266706172616d73f66776657273696f6e017576a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  V: '00596d34a163726571a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea266706172616d73f66776657273696f6e027576a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  C: '00596d4c60a263657874a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea1687265766973696f6e0063726571a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea266706172616d73f66776657273696f6e0175ab76a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  D: '00596d3fa263657874a1781975726e3a6578616d706c653a646973706c61793a776f726473a2636f6e65646974656d646d616e79656974656d736373796d644954454d7576a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  M: '00596d06a163726571f67576a914fc63218003683dc3305d0644a52f73eb0802e5c188ac',
  X: '00596d4c8da263657874a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea1687265766973696f6e0063726571a2781975726e3a6578616d706c653a636f6c6f723a756e6b6e6f776ea266706172616d73f66776657273696f6e01781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea266706172616d73f66776657273696f6e0175ab76a914fc63218003683dc3305d0644a52f73eb0802e5c188ac'
} as const
const payloadOf = (scriptHex: string): number[] | undefined =>
  OneColor.decode(LockingScript.fromHex(scriptHex)).payload

const ATTESTED = 'https://brc.dev/207/attested'
const MANDALA = 'https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md'
const MAX_ID = 'a:' + 'x'.repeat(198)
const OVER_MAX_ID = 'a:' + 'x'.repeat(199)

describe('isProfileId', () => {
  it('pins the fixture lengths (contract §4: the Mandala id is 80 bytes; 200-byte boundary)', () => {
    expect(MANDALA).toHaveLength(80)
    expect(MAX_ID).toHaveLength(200)
    expect(OVER_MAX_ID).toHaveLength(201)
  })

  it.each([
    ATTESTED,
    MANDALA,
    'urn:example:color:revision',
    'urn:example:color:unknown',
    'a:b',
    'a+b.c-d:x',
    MAX_ID
  ])('accepts %s', id => {
    expect(isProfileId(id)).toBe(true)
  })

  it.each([
    '',
    OVER_MAX_ID,
    'Https://x',
    '1a:b',
    ':b',
    'ab',
    'a:',
    'a:b c',
    'a:b\x7f',
    'a:bé',
    'a:b\n',
    'a:\tb'
  ])('rejects %j', id => {
    expect(isProfileId(id)).toBe(false)
  })

  it('rejects non-strings at runtime', () => {
    for (const v of [undefined, null, 42, ['a:b']]) expect(isProfileId(v as never)).toBe(false)
  })
})

describe('readOneColorAttributes: payload and display fields', () => {
  const OPAQUE = {
    payload: 'opaque',
    dec: ABSENT,
    sym: ABSENT,
    icon: ABSENT,
    req: ABSENT,
    ext: ABSENT
  }

  it('classifies absent, empty and map payloads', () => {
    expect(readOneColorAttributes(undefined)).toEqual({
      payload: 'absent',
      dec: ABSENT,
      sym: ABSENT,
      icon: ABSENT,
      req: ABSENT,
      ext: ABSENT
    })
    for (const e of [[], new Uint8Array(0)]) {
      expect(readOneColorAttributes(e)).toEqual({
        payload: 'empty',
        dec: ABSENT,
        sym: ABSENT,
        icon: ABSENT,
        req: ABSENT,
        ext: ABSENT
      })
    }
    const empty = readOneColorAttributes([0xa0])
    expect(empty.payload).toBe('map')
    expect(empty.map).toEqual({})
    expect(empty.dec).toEqual(ABSENT)
    expect(empty.sym).toEqual(ABSENT)
    expect(empty.icon).toEqual(ABSENT)
    expect(readOneColorAttributes(new Uint8Array([0xa0])).payload).toBe('map')
  })

  // RF3: hostile input is opaque, never throws, no partial recovery (0207:82-87)
  it.each([
    ['uint not map', [0x01]],
    ['valid CBOR array', [0x80]],
    ['trailing bytes', [0xa0, 0x00]],
    ['duplicate keys', [...hex('a2 6164 01 6164 02')]],
    ['unsorted keys', [...hex('a2 6173 01 6164 02')]],
    ['indefinite map', [0xbf, 0xff]],
    ['entry > 255', [0xa0, 256]],
    ['negative entry', [-1]],
    ['fractional entry', [1.5]],
    ['valid map then a dec-bearing trailer', [0xa0, ...cbor({ dec: 2n })]]
  ])('%s is opaque', (_, bytes) => {
    const a = readOneColorAttributes(bytes as number[])
    expect(a).toEqual(OPAQUE)
    expect(a.map).toBeUndefined()
    expect(a.reqBytes).toBeUndefined()
  })

  it('nesting beyond the decoder policy is opaque, never a throw', () => {
    // Containers deeper than STRICT_CBOR_MAX_DEPTH, and a 200000-deep chain of tags.
    const arrays = [0xa1, 0x61, 0x61, ...Array.from({ length: 5000 }, () => 0x81), 0x01]
    const tags = [
      0xa1,
      0x61,
      0x61,
      ...Array.from({ length: 200_000 }, () => [0xd8, 0x2a]).flat(),
      0x40
    ]
    const ext = [...hex('a1 63657874 a1 6a75726e3a783a61626364'), ...arrays.slice(3)]
    for (const bytes of [arrays, tags, ext]) {
      expect(readOneColorAttributes(bytes)).toEqual(OPAQUE)
      expect(readOneColorAttributes(Uint8Array.from(bytes))).toEqual(OPAQUE)
    }
  })

  it('never throws on runtime garbage', () => {
    const revoked = Proxy.revocable([] as number[], {})
    revoked.revoke()
    const throwingIterable = Object.assign([1], {
      [Symbol.iterator]: () => {
        throw new Error('boom')
      }
    })
    for (const v of [null, 'a0', '', 42, {}, [[0xa0]], revoked.proxy, throwingIterable]) {
      expect(readOneColorAttributes(v as never)).toEqual(OPAQUE)
    }
  })

  it('is deterministic: same input, same output', () => {
    const bytes = cbor({ dec: 2n, sym: 'T', icon: ['image/png', new Uint8Array([1])] })
    expect(readOneColorAttributes(bytes)).toEqual(readOneColorAttributes(Uint8Array.from(bytes)))
  })

  // dec: uint 0..18 (0162:246-252)
  it('reads dec', () => {
    expect(readOneColorAttributes(cbor({ dec: 0n })).dec).toEqual({ status: 'valid', value: 0 })
    expect(readOneColorAttributes(cbor({ dec: 18n })).dec).toEqual({ status: 'valid', value: 18 })
    expect(valid(readOneColorAttributes(cbor({ dec: 8n })).dec)).toBe(8)
    for (const bad of [
      19n,
      -1n,
      2n ** 64n - 1n,
      'two',
      null,
      true,
      new Uint8Array([2]),
      [2n],
      { v: 2n },
      2.5
    ])
      expect(readOneColorAttributes(cbor({ dec: bad })).dec.status).toBe('malformed')
  })

  it('RF1-dec: a float64 dec (2.0) is malformed, not coerced', () => {
    const a = readOneColorAttributes(hex('a1 63646563 fb4000000000000000'))
    expect(a.payload).toBe('map')
    expect(a.dec.status).toBe('malformed')
  })

  it('reads sym as any text', () => {
    expect(readOneColorAttributes(cbor({ sym: 'TUSD' })).sym).toEqual({
      status: 'valid',
      value: 'TUSD'
    })
    expect(readOneColorAttributes(cbor({ sym: '' })).sym).toEqual({ status: 'valid', value: '' })
    for (const bad of [new Uint8Array([1]), 1n, null, ['TUSD']])
      expect(readOneColorAttributes(cbor({ sym: bad })).sym.status).toBe('malformed')
  })

  // icon: exactly [text, bytes] (0162:236-240)
  it('reads icon', () => {
    const ok = readOneColorAttributes(
      cbor({ icon: ['image/png', new Uint8Array([0x89, 0x50])] })
    ).icon
    expect(ok).toEqual({
      status: 'valid',
      value: { mediaType: 'image/png', bytes: new Uint8Array([0x89, 0x50]) }
    })
    expect(valid(ok).bytes).toBeInstanceOf(Uint8Array)
    for (const bad of [
      [],
      ['image/png'],
      ['image/png', new Uint8Array([1]), 'x'],
      [new Uint8Array([1]), 'image/png'],
      ['image/png', 'notbytes'],
      'image/png',
      null,
      { mediaType: 'image/png', bytes: new Uint8Array([1]) }
    ])
      expect(readOneColorAttributes(cbor({ icon: bad as never })).icon.status).toBe('malformed')
  })

  it('a malformed display field does not affect its siblings (0207:88-93)', () => {
    const a = readOneColorAttributes(cbor({ dec: 99n, sym: 'OK', icon: 'bad' }))
    expect(a.payload).toBe('map')
    expect(a.dec.status).toBe('malformed')
    expect(a.sym).toEqual({ status: 'valid', value: 'OK' })
    expect(a.icon.status).toBe('malformed')
  })

  it('fixture D (0207 A.141a): sym ITEM, advisory keys kept in map', () => {
    const a = readOneColorAttributes(payloadOf(FIXTURE.D))
    expect(a.payload).toBe('map')
    expect(a.sym).toEqual({ status: 'valid', value: 'ITEM' })
    expect(a.dec).toEqual(ABSENT)
    expect(a.icon).toEqual(ABSENT)
    expect(Object.keys(a.map!)).toEqual(['ext', 'sym'])
  })

  it('every A.141a fixture payload decodes as a map', () => {
    for (const script of Object.values(FIXTURE))
      expect(readOneColorAttributes(payloadOf(script)).payload).toBe('map')
  })
})

// Contract §4 fixture F-REQ (generated with encodeStrictCbor at ts-stack cbdccfe), verbatim.
const K = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
const REQ_HEX =
  'a2781c68747470733a2f2f6272632e6465762f3230372f6174746573746564a266706172616d73a26974727573744d6f6465686964656e746974796b6964656e746974794b657978423032373938623831393531613661386337656638626564613039623036613233303331643765666166333762363633323635653031383861623337383132343034366776657273696f6e01785068747470733a2f2f6769746875622e636f6d2f6273762d626c6f636b636861696e2f6d616e64616c612f626c6f622f6d61737465722f646f63732f70726f66696c65732f6973737565722d76312e6d64a266706172616d73a16b6964656e746974794b657978423032373938623831393531613661386337656638626564613039623036613233303331643765666166333762363633323635653031383861623337383132343034366776657273696f6e01'
const FREQ_PAYLOAD =
  'a4636465630263726571' + REQ_HEX + '6373796d6454555344656c6162656c6b5465737420446f6c6c6172'

describe('readOneColorAttributes: req and ext', () => {
  it('pins the F-REQ fixture sizes (contract §4)', () => {
    expect(REQ_HEX.length / 2).toBe(328)
    expect(FREQ_PAYLOAD.length / 2).toBe(365)
  })

  it('F-REQ: Mandala deploy payload (req in the middle of the map)', () => {
    const a = readOneColorAttributes(hex(FREQ_PAYLOAD))
    expect(a.payload).toBe('map')
    expect(a.dec).toEqual({ status: 'valid', value: 2 })
    expect(a.sym).toEqual({ status: 'valid', value: 'TUSD' })
    expect(a.map!.label).toBe('Test Dollar')
    const req = valid(a.req)
    expect([...req.keys()]).toEqual([ATTESTED, MANDALA])
    expect(req.get(ATTESTED)).toEqual({
      version: 1,
      params: { trustMode: 'identity', identityKey: K }
    })
    expect(req.get(MANDALA)).toEqual({ version: 1, params: { identityKey: K } })
    expect(toHex([...a.reqBytes!])).toBe(REQ_HEX)
    expect(a.reqBytes!).toHaveLength(328)
    expect(a.reqBytes).toBeInstanceOf(Uint8Array)
    expect(a.ext).toEqual(ABSENT)
    // number[] input reads identically
    const fromArray = readOneColorAttributes([...hex(FREQ_PAYLOAD)])
    expect(toHex([...fromArray.reqBytes!])).toBe(REQ_HEX)
  })

  it('A.141a fixtures (req last in the map for C and X)', () => {
    const u = readOneColorAttributes(payloadOf(FIXTURE.U))
    expect([...valid(u.req).entries()]).toEqual([
      ['urn:example:color:unknown', { version: 1, params: null }]
    ])
    expect(u.ext).toEqual(ABSENT)
    expect(
      valid(readOneColorAttributes(payloadOf(FIXTURE.V)).req).get('urn:example:color:revision')!
        .version
    ).toBe(2)
    const c = readOneColorAttributes(payloadOf(FIXTURE.C))
    expect(valid(c.ext).get('urn:example:color:revision')).toEqual({ revision: 0n })
    expect(toHex([...c.reqBytes!])).toBe(
      'a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea266706172616d73f66776657273696f6e01'
    )
    const x = readOneColorAttributes(payloadOf(FIXTURE.X))
    expect([...valid(x.req).keys()]).toEqual([
      'urn:example:color:unknown',
      'urn:example:color:revision'
    ]) // canonical order
    const d = readOneColorAttributes(payloadOf(FIXTURE.D))
    expect(d.req).toEqual(ABSENT)
    expect(d.reqBytes).toBeUndefined()
    expect([...valid(d.ext).keys()]).toEqual(['urn:example:display:words'])
  })

  it('A.147 fixture M: req null is malformed, not absent', () => {
    const m = readOneColorAttributes(payloadOf(FIXTURE.M))
    expect(m.payload).toBe('map')
    expect(m.req.status).toBe('malformed')
    expect(m.reqBytes).toBeUndefined()
  })

  it('an empty req map is valid and its bytes are a0', () => {
    const a = readOneColorAttributes(cbor({ req: {} }))
    expect(a.req.status).toBe('valid')
    expect(valid(a.req).size).toBe(0)
    expect([...a.reqBytes!]).toEqual([0xa0])
  })

  it('a map without req has no reqBytes', () => {
    const a = readOneColorAttributes(cbor({ sym: 'S' }))
    expect(a.req).toEqual(ABSENT)
    expect(a.ext).toEqual(ABSENT)
    expect(a.reqBytes).toBeUndefined()
  })

  it.each([
    ['descriptor missing params', { 'a:b': { version: 1n } }],
    ['descriptor missing version', { 'a:b': { params: null } }],
    ['descriptor extra member', { 'a:b': { version: 1n, params: null, x: 1n } }],
    ['descriptor empty map', { 'a:b': {} }],
    ['descriptor not a map', { 'a:b': [1n, null] }],
    ['descriptor null', { 'a:b': null }],
    ['version 0', { 'a:b': { version: 0n, params: null } }],
    ['version 2^32', { 'a:b': { version: 4294967296n, params: null } }],
    ['version negative', { 'a:b': { version: -1n, params: null } }],
    ['version text', { 'a:b': { version: '1', params: null } }],
    ['version fractional float', { 'a:b': { version: 1.5, params: null } }],
    ['bad profile id', { 'Bad:x': { version: 1n, params: null } }],
    [
      'one good entry and one bad profile id',
      { 'a:b': { version: 1n, params: null }, nocolon: { version: 1n, params: null } }
    ],
    ['profile id over 200 bytes', { [OVER_MAX_ID]: { version: 1n, params: null } }]
  ])('req malformed: %s', (_, req) => {
    const a = readOneColorAttributes(cbor({ req: req as never }))
    expect(a.payload).toBe('map')
    expect(a.req.status).toBe('malformed')
    expect(a.reqBytes).toBeUndefined()
  })

  it('req that is not a map (array, bytes, text, int, bool, link) is malformed', () => {
    for (const req of [
      [],
      new Uint8Array([0xa0]),
      'a0',
      1n,
      true,
      new StrictCborLink(new Uint8Array([0, 1]))
    ]) {
      const a = readOneColorAttributes(cbor({ req: req as never }))
      expect(a.req.status).toBe('malformed')
      expect(a.reqBytes).toBeUndefined()
    }
  })

  it('RF1-version: boundaries and float', () => {
    expect(
      valid(
        readOneColorAttributes(cbor({ req: { 'a:b': { version: 4294967295n, params: null } } })).req
      ).get('a:b')!.version
    ).toBe(4294967295)
    expect(
      valid(
        readOneColorAttributes(cbor({ req: { 'a:b': { version: 1n, params: null } } })).req
      ).get('a:b')!.version
    ).toBe(1)
    // version float64 1.0, hand-written (encodeStrictCbor cannot produce it)
    const f = readOneColorAttributes(
      hex('a1 63726571 a1 63613a62 a2 66706172616d73 f6 6776657273696f6e fb3ff0000000000000')
    )
    expect(f.payload).toBe('map')
    expect(f.req.status).toBe('malformed')
    expect(f.reqBytes).toBeUndefined()
  })

  it('RF2-span: an integral float in params is kept byte-exact', () => {
    const FLOAT_REQ = 'a163613a62a266706172616d73fb3ff00000000000006776657273696f6e01'
    const a = readOneColorAttributes(hex('a163726571' + FLOAT_REQ))
    expect(a.req.status).toBe('valid')
    expect(toHex([...a.reqBytes!])).toBe(FLOAT_REQ)
    // the re-encoding would have folded 1.0 into the integer 1: the span must not equal it
    expect(toHex(encodeStrictCbor({ 'a:b': { params: 1n, version: 1n } }))).not.toBe(FLOAT_REQ)
  })

  it('span is exact through nested arrays, bytes, negative ints and tag-42 links', () => {
    const req = {
      'a:b': {
        version: 1n,
        params: [
          new StrictCborLink(new Uint8Array([0, 1, 2])),
          new Uint8Array([1, 2]),
          -5n,
          'x',
          true,
          { k: [null] }
        ]
      }
    }
    const a = readOneColorAttributes(cbor({ req, sym: 'S' }))
    // no floats here, so re-encoding is a valid oracle
    expect(toHex([...a.reqBytes!])).toBe(toHex(encodeStrictCbor(req)))
    expect(a.sym).toEqual({ status: 'valid', value: 'S' })
  })

  it('span is exact past preceding values with multi-byte heads (1/2/4/8-byte arguments)', () => {
    const req = {
      'a:b': { version: 4294967295n, params: [2n ** 64n - 1n, -(2n ** 40n), 'y'.repeat(300)] }
    }
    const payload = {
      // keys shorter than 'req' sort first and must be skipped by the span finder
      a: new Uint8Array(70000),
      b: [2n ** 63n, 'z'.repeat(256), { c: -(2n ** 33n) }],
      e: 1.5,
      req,
      zzzz: [new Uint8Array(300), { q: 70000n }]
    }
    const a = readOneColorAttributes(cbor(payload))
    expect(a.req.status).toBe('valid')
    expect(toHex([...a.reqBytes!])).toBe(toHex(encodeStrictCbor(req)))
  })

  it('reqBytes is a fresh copy, detached from the input and from other reads', () => {
    const input = hex(FREQ_PAYLOAD)
    const a = readOneColorAttributes(input)
    const b = readOneColorAttributes(input)
    expect(a.reqBytes).not.toBe(b.reqBytes)
    a.reqBytes![0] ^= 0xff
    expect(toHex([...b.reqBytes!])).toBe(REQ_HEX)
    expect(toHex([...input])).toBe(FREQ_PAYLOAD)
    expect(toHex([...readOneColorAttributes(input).reqBytes!])).toBe(REQ_HEX)
  })

  it('reads the input once: an array whose contents change between reads cannot skew the span', () => {
    const good = [...hex('a163726571a0')]
    let reads = 0
    // Each full iteration after the first yields a truncated, unvalidated byte sequence.
    const shifty = new Proxy(good, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) {
          reads++
          const src = reads === 1 ? target : [0xa1, 0x63, 0x72, 0x65, 0x71, 0x9b]
          return () => src[Symbol.iterator]()
        }
        return Reflect.get(target, prop, receiver)
      }
    })
    const a = readOneColorAttributes(shifty)
    expect(a.req.status).toBe('valid')
    expect([...a.reqBytes!]).toEqual([0xa0])
    expect(reads).toBe(1)
  })

  it('is deterministic for req and ext', () => {
    const r1 = readOneColorAttributes(hex(FREQ_PAYLOAD))
    const r2 = readOneColorAttributes([...hex(FREQ_PAYLOAD)])
    expect(r1).toEqual(r2)
  })

  it('ext: map of profile ids to any value', () => {
    expect(valid(readOneColorAttributes(cbor({ ext: { 'a:b': null } })).ext).get('a:b')).toBeNull()
    expect(valid(readOneColorAttributes(cbor({ ext: {} })).ext).size).toBe(0)
    for (const ext of [null, [], 'x', 1n, new Uint8Array([0xa0]), { nocolon: 1n }, { 'Bad:x': 1n }])
      expect(readOneColorAttributes(cbor({ ext: ext as never })).ext.status).toBe('malformed')
  })

  it('req/ext malformed does not disturb the display fields', () => {
    const a = readOneColorAttributes(cbor({ req: null, ext: null, sym: 'S', dec: 2n }))
    expect(a.req.status).toBe('malformed')
    expect(a.ext.status).toBe('malformed')
    expect(a.sym.status).toBe('valid')
    expect(a.dec.status).toBe('valid')
  })

  it('ext malformed does not disturb a valid req and its span', () => {
    const a = readOneColorAttributes(cbor({ req: {}, ext: [] }))
    expect(a.ext.status).toBe('malformed')
    expect(a.req.status).toBe('valid')
    expect([...a.reqBytes!]).toEqual([0xa0])
  })

  it('opaque payloads never expose req, ext or reqBytes even when they contain req bytes', () => {
    const a = readOneColorAttributes([...hex('a163726571' + 'a0'), 0x00]) // trailing byte
    expect(a.payload).toBe('opaque')
    expect(a.req).toEqual(ABSENT)
    expect(a.reqBytes).toBeUndefined()
  })
})

describe('reqMatchesDeploy', () => {
  const R = readOneColorAttributes
  const deploy = R(hex(FREQ_PAYLOAD))

  it('later outputs that omit req inherit it (0162:188-190, A.145)', () => {
    for (const later of [R(undefined), R([]), R([0x01]), R(cbor({ sym: 'X' }))])
      expect(reqMatchesDeploy(deploy, later)).toBe(true)
  })

  it('a repeated req must be byte-identical', () => {
    expect(reqMatchesDeploy(deploy, R([...hex('a163726571' + REQ_HEX)]))).toBe(true)
    expect(reqMatchesDeploy(deploy, deploy)).toBe(true)
    expect(reqMatchesDeploy(deploy, R(cbor({ req: {} })))).toBe(false) // A.146
    const otherKey = {
      [ATTESTED]: {
        version: 1n,
        params: { trustMode: 'identity', identityKey: K.replace(/^02/, '03') }
      },
      [MANDALA]: { version: 1n, params: { identityKey: K } }
    }
    expect(reqMatchesDeploy(deploy, R(cbor({ req: otherKey })))).toBe(false)
  })

  it('an absent deploy req is the empty map a0', () => {
    for (const d of [R(cbor({ sym: 'X' })), R(undefined), R([]), R([0x01])]) {
      expect(reqMatchesDeploy(d, R(cbor({ req: {} })))).toBe(true)
      expect(reqMatchesDeploy(d, R(cbor({ req: { 'a:b': { version: 1n, params: null } } })))).toBe(
        false
      )
    }
  })

  it('a malformed later req never matches', () => {
    expect(reqMatchesDeploy(deploy, R(cbor({ req: null })))).toBe(false)
    expect(reqMatchesDeploy(R(cbor({ sym: 'X' })), R(cbor({ req: null })))).toBe(false)
  })

  it('RF5: a malformed deploy req (fixture M) matches nothing, even an omitted req', () => {
    const m = R(payloadOf(FIXTURE.M))
    expect(m.req.status).toBe('malformed')
    for (const later of [
      R(undefined),
      R([]),
      R([0x01]),
      R(cbor({ sym: 'X' })),
      R(cbor({ req: {} })),
      R(cbor({ req: null })),
      m
    ])
      expect(reqMatchesDeploy(m, later)).toBe(false)
  })

  it('RF2-match: Float 1.0 and Int 1 in params are different requirements', () => {
    const f = R(hex('a163726571 a163613a62a266706172616d73fb3ff00000000000006776657273696f6e01'))
    const i = R(cbor({ req: { 'a:b': { params: 1n, version: 1n } } }))
    expect(valid(f.req).get('a:b')).toEqual({ version: 1, params: 1 })
    expect(valid(i.req).get('a:b')).toEqual({ version: 1, params: 1n })
    expect(reqMatchesDeploy(f, i)).toBe(false)
    expect(reqMatchesDeploy(i, f)).toBe(false)
    expect(reqMatchesDeploy(f, f)).toBe(true)
  })

  it('is total: a hand-built valid req without reqBytes fails closed instead of throwing', () => {
    const noBytes = { ...deploy, reqBytes: undefined }
    expect(reqMatchesDeploy(deploy, noBytes)).toBe(false)
    expect(reqMatchesDeploy(noBytes, deploy)).toBe(false)
    expect(reqMatchesDeploy(noBytes, R(cbor({ sym: 'X' })))).toBe(true) // step 2 is unaffected
  })

  it('is pure: same inputs give the same answer and nothing is mutated', () => {
    const later = R([...hex('a163726571' + REQ_HEX)])
    const before = toHex([...deploy.reqBytes!]) + toHex([...later.reqBytes!])
    expect(reqMatchesDeploy(deploy, later)).toBe(true)
    expect(reqMatchesDeploy(deploy, later)).toBe(true)
    expect(toHex([...deploy.reqBytes!]) + toHex([...later.reqBytes!])).toBe(before)
  })
})

describe('needsEmptyPayloadMarker', () => {
  const D = { op: OP.OP_DROP }
  const PKH = Array.from({ length: 20 }, (_, i) => i + 1)
  it.each([
    ['OP_0', [{ op: OP.OP_0 }, D]],
    ['OP_1NEGATE', [{ op: OP.OP_1NEGATE }, D]],
    ['OP_1', [{ op: OP.OP_1 }, D]],
    ['OP_16', [{ op: OP.OP_16 }, D]],
    ['direct push', [{ op: 2, data: [1, 2] }, D]],
    ['non-minimal PUSHDATA1', [{ op: OP.OP_PUSHDATA1, data: [7] }, D, { op: OP.OP_TRUE }]]
  ])('RF4: %s then OP_DROP needs the marker', (_, chunks) =>
    expect(needsEmptyPayloadMarker(chunks as ScriptChunk[])).toBe(true)
  )
  it.each([
    ['empty', []],
    ['OP_DROP alone', [D]],
    ['push alone', [{ op: OP.OP_5 }]],
    ['push then 2DROP', [{ op: OP.OP_5 }, { op: OP.OP_2DROP }]],
    ['OP_DUP then OP_DROP', [{ op: OP.OP_DUP }, D]],
    ['P2PKH', new P2PKH().lock(PKH).chunks],
    ['P2PK', [{ op: 33, data: Array(33).fill(2) }, { op: OP.OP_CHECKSIG }]]
  ])('%s needs no marker', (_, chunks) =>
    expect(needsEmptyPayloadMarker(chunks as ScriptChunk[])).toBe(false)
  )
  it('does not mutate the caller array', () => {
    const chunks: ScriptChunk[] = [{ op: OP.OP_5 }, D]
    const frozen = Object.freeze(chunks.map(c => Object.freeze({ ...c })))
    expect(needsEmptyPayloadMarker(frozen)).toBe(true)
    expect(frozen).toEqual(chunks)
  })
})
