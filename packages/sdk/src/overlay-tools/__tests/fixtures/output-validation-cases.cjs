// Hand-authored public boundary cases. Expected observations are frozen from
// the integrity-verified published SDK, independently of the source under test.
const { createHash } = require('node:crypto')

function values() {
  const cases = [
    ['null', () => null],
    ['true', () => true],
    ['false', () => false],
    ['zero', () => 0],
    ['negative-zero', () => -0],
    ['integer', () => 7],
    ['negative', () => -1],
    ['maximum-safe', () => Number.MAX_SAFE_INTEGER],
    ['fraction', () => 0.5],
    ['unsafe', () => Number.MAX_SAFE_INTEGER + 1],
    ['nan', () => Number.NaN],
    ['infinity', () => Infinity],
    ['negative-infinity', () => -Infinity],
    ['undefined', () => undefined],
    ['bigint', () => 1n],
    ['symbol', () => Symbol('fixture')],
    ['function', () => () => 1],
    ['empty-text', () => ''],
    ['ascii', () => 'plain'],
    ['unicode', () => 'é😀'],
    ['escaped', () => '"\\\n\t\u0000'],
    ['leading-surrogate', () => '\uD800'],
    ['trailing-surrogate', () => '\uDC00'],
    ['empty-array', () => []],
    ['array', () => [null, true, -0, 'é😀', { b: 2, a: 1 }]],
    ['hole', () => Object.assign([], { length: 1 })],
    ['array-extra', () => Object.assign([1], { extra: true })],
    ['empty-object', () => ({})],
    ['flat-strings', () => ({ z: 'last', a: 'first' })],
    ['flat-scalars', () => ({ z: null, a: true, b: -0, c: 123, d: 'text' })],
    ['nested', () => ({ z: [{ b: 2, a: ['é😀', false] }], a: {} })],
    ['builtin-keys', () => ({ ['__proto__']: 'data', constructor: 'retained', prototype: 0 })],
    ['numeric-keys', () => ({ 10: 'ten', 2: 'two', a: 'letter' })],
    ['null-prototype', () => Object.assign(Object.create(null), { value: 1 })],
    [
      'shared-child',
      () => {
        const child = { value: 1 }
        return { a: child, b: child }
      }
    ],
    [
      'cycle',
      () => {
        const value = {}
        value.self = value
        return value
      }
    ],
    ['date', () => new Date(0)],
    ['inherited', () => Object.create({ value: 1 })],
    ['symbol-key', () => ({ value: 1, [Symbol('hidden')]: true })],
    ['hidden-key', () => Object.defineProperty({ value: 1 }, 'hidden', { value: true })],
    [
      'getter',
      () =>
        Object.defineProperty({}, 'value', {
          enumerable: true,
          get() {
            throw new Error('Input getter executed')
          }
        })
    ],
    ['undefined-child', () => ({ value: undefined })],
    ['control-key', () => ({ ['\u0000']: 'value' })],
    ['unicode-key', () => ({ ['é😀']: 'value' })],
    [
      'wide-object',
      () => Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['key' + i, i]))
    ],
    ['long-array', () => Array.from({ length: 4097 }, () => 0)]
  ]
  for (const point of [
    0, 8, 9, 10, 12, 13, 31, 32, 33, 34, 91, 92, 93, 126, 127, 128, 2047, 2048, 0xd7ff, 0xe000,
    0xffff, 0x10000, 0x10ffff
  ]) {
    const text = String.fromCodePoint(point)
    cases.push(
      ['unicode-point-' + point, () => text],
      ['unicode-context-' + point, () => 'a' + text + 'b'],
      ['unicode-key-' + point, () => ({ [text]: text })]
    )
  }
  return cases
}

function graphMetadata(root) {
  const rows = [],
    seen = new Map(),
    negativeZeros = []
  function visit(value, path) {
    if (Object.is(value, -0)) negativeZeros.push(path)
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) {
      rows.push([path, 'alias', seen.get(value)])
      return
    }
    seen.set(value, path)
    const keys = Reflect.ownKeys(value),
      fields = []
    rows.push([path, graphPrototype(value), fields])
    for (const key of keys) {
      const name = typeof key === 'symbol' ? 'symbol:' + key.description : key
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      fields.push([
        name,
        Number(descriptor.enumerable) +
          2 * Number(descriptor.configurable) +
          4 * Number(descriptor.writable),
        'value' in descriptor ? 'data' : 'accessor'
      ])
      if ('value' in descriptor) visit(descriptor.value, path + '/' + JSON.stringify(name))
    }
  }
  visit(root, '')
  return { rows, negativeZeros }
}

function graphPrototype(value) {
  if (Array.isArray(value)) return 'array'
  const prototype = Object.getPrototypeOf(value)
  if (prototype === null) return 'null'
  return Object.getPrototypeOf(prototype) === null ? 'plain' : 'other'
}
function resultPrototype(value) {
  if (value === null || typeof value !== 'object') return typeof value
  if (Array.isArray(value)) return 'array'
  return Object.getPrototypeOf(value) === null ? 'null' : 'object'
}
function encodedObservation(value) {
  if (new Set(['undefined', 'function', 'symbol']).has(typeof value)) return { undefined: true }
  const json = JSON.stringify(value, (_key, v) =>
    typeof v === 'bigint' ? { bigint: String(v) } : v
  )
  if (json.length <= 2048) return { json }
  return { length: json.length, sha256: createHash('sha256').update(json).digest('hex') }
}
function observation(run) {
  try {
    const value = run()
    return {
      prototype: resultPrototype(value),
      negativeZero: Object.is(value, -0),
      graph: graphMetadata(value),
      ...encodedObservation(value)
    }
  } catch (error) {
    return { error: { name: error.name, code: error.code, message: error.message } }
  }
}

function ownerInputCases(add, j, name, limits) {
  for (const [id, make] of values())
    for (const [i, bound] of limits.entries())
      add(name, id + '/limit-' + i, () => j[name](make(), bound))
}

function parsedInputCases(add, j, name, limits) {
  const texts = [
    'null',
    'true',
    'false',
    '0',
    '-0',
    '1.00',
    '1e2',
    '9007199254740991',
    '"plain"',
    '"é😀"',
    String.raw`"\u0061"`,
    String.raw`"\n"`,
    '[]',
    '{}',
    '[null,true,-0,"é😀"]',
    '{"z":"last","a":"first"}',
    '{"a":1,"b":true,"c":null,"d":"text"}',
    '{"10":1,"2":2}',
    '{"a":{},"b":[1,{"z":"é😀"}]}',
    ' \r\n{ "a" : "first", "b": "second" }\t',
    '',
    ' ',
    'undefined',
    '01',
    '+1',
    '-',
    '1e',
    '1.5',
    '9007199254740992',
    'true false',
    '[1,]',
    '[1:2]',
    '[1 2]',
    '{"a"!1}',
    '{"a":1!"b":2}',
    '1e00',
    '1e+01',
    '1e-00',
    '{"a":1,}',
    '{"a":1,"a":2}',
    String.raw`{"a":1,"\u0061":2}`,
    '"unfinished',
    String.raw`"unfinished\"`,
    '"raw\ncontrol"',
    String.raw`"\uD800"`,
    String.raw`"\uDC00"`,
    '\uFEFF{}'
  ]
  for (const point of [
    0, 8, 9, 10, 12, 13, 31, 32, 33, 34, 91, 92, 93, 126, 127, 128, 2047, 2048, 0xd7ff, 0xe000,
    0xffff, 0x10000, 0x10ffff
  ]) {
    const text = String.fromCodePoint(point)
    texts.push(JSON.stringify(text), JSON.stringify({ [text]: text }))
  }
  for (const [i, text] of texts.entries()) {
    for (const [k, bound] of limits.entries()) {
      add(name, 'text-' + i + '/limit-' + k, () => j[name](text, bound))
      add(name, 'utf8-' + i + '/limit-' + k, () =>
        j[name](Uint8Array.from(Buffer.from(text)), bound)
      )
    }
  }
  add(name, 'invalid-utf8', () => j[name](Uint8Array.from([255])))
}

function invalidLimitCases(add, j, name, isOwner) {
  for (const key of ['bytes', 'depth', 'arrayElements', 'mapKeys']) {
    for (const [i, invalid] of [0, -1, 0.5, Number.NaN, Infinity, null, '1'].entries())
      add(name, 'invalid-limit-' + key + '-' + i, () =>
        j[name](isOwner ? {} : '{}', { [key]: invalid })
      )
  }
}

function jsonInputCases(add, j, owners, readers, limits) {
  for (const name of [...owners, ...readers]) {
    if (typeof j[name] !== 'function') throw new Error('Missing released JSON API ' + name)
    if (owners.has(name)) ownerInputCases(add, j, name, limits)
    else parsedInputCases(add, j, name, limits)
    invalidLimitCases(add, j, name, owners.has(name))
  }
}

function jsonBoundaryPointCases(add, j, name, isOwner, i, value) {
  const text = JSON.stringify(value),
    bytes = Buffer.byteLength(text)
  const depth = value =>
    value === null || typeof value !== 'object'
      ? 1
      : 1 + Math.max(0, ...Object.values(value).map(depth))
  const fences = [
    { bytes },
    { bytes: bytes - 1 },
    { bytes: bytes + 1 },
    { depth: depth(value) },
    { depth: depth(value) - 1 },
    { arrayElements: 2 },
    { mapKeys: 2 }
  ]
  for (const [k, bound] of fences.entries()) {
    add(name, 'boundary-' + i + '/' + k, () => j[name](isOwner ? value : text, bound))
    if (!isOwner)
      add(name, 'boundary-utf8-' + i + '/' + k, () =>
        j[name](Uint8Array.from(Buffer.from(text)), bound)
      )
  }
}

function jsonBoundaryCases(add, j, owners, readers, boundaries) {
  for (const name of [...owners, ...readers]) {
    for (const [i, value] of boundaries.entries())
      jsonBoundaryPointCases(add, j, name, owners.has(name), i, value)
  }
}

function reportedByteLengthCases(add, j) {
  for (const name of [
    'inspectOutputJSONEncoding',
    'inspectOutputJSONEncodingWithScalarRecords',
    'inspectOutputJSONEncodingWithOwnedRecords'
  ]) {
    for (const text of ['{"a":"é😀"}', '["é😀"]', String.raw`{"a":"\u0061"}`]) {
      for (const reported of [0, 1]) {
        for (const maximum of [4, 8, 16]) {
          add(name, 'reported-byte-length-' + reported + '-' + maximum + '-' + text, () => {
            const input = Uint8Array.from(Buffer.from(text))
            Object.defineProperty(input, 'byteLength', { value: reported })
            return j[name](input, { bytes: maximum })
          })
        }
      }
    }
  }
}

function protocolBoundaryCases(add, p, scalars) {
  for (const name of [
    'outputU64',
    'incrementOutputU64',
    'outputU32',
    'outputHex32',
    'outputString',
    'outputIdentity',
    'decodeOutputBytes',
    'validateOutputByteEncoding'
  ]) {
    if (typeof p[name] !== 'function') throw new Error('Missing released protocol API ' + name)
    for (const [i, value] of scalars.entries()) add(name, 'scalar-' + i, () => p[name](value))
  }
  for (const [i, value] of [0, 1, 2, 3, -1, 0.5, Number.NaN, Infinity].entries()) {
    add('decodeOutputBytes', 'limit-' + i, () => p.decodeOutputBytes('AQID', value))
    add('validateOutputByteEncoding', 'limit-' + i, () =>
      p.validateOutputByteEncoding('AQID', value)
    )
  }
  for (const [i, value] of [
    {},
    { extensions: null },
    { extensions: [] },
    { extensions: 'text' },
    { extensions: { 'urn:fixture:a': null } },
    { extensions: { relative: true } },
    { extensions: { 'urn:fixture:a': null }, critical: ['urn:fixture:a'] },
    { critical: ['urn:fixture:a'] },
    { critical: null },
    { critical: 'urn:fixture:a' },
    { critical: [1] },
    { critical: ['urn:fixture:a', 'urn:fixture:a'] },
    {
      extensions: Object.fromEntries(Array.from({ length: 33 }, (_, k) => ['urn:fixture:' + k, k]))
    },
    { critical: Array.from({ length: 33 }, (_, k) => 'urn:fixture:' + k) },
    {
      extensions: Object.fromEntries(Array.from({ length: 32 }, (_, k) => ['urn:fixture:' + k, k]))
    },
    { extensions: { '1urn:fixture:a': null } },
    {
      extensions: Object.fromEntries(Array.from({ length: 32 }, (_, k) => ['urn:fixture:' + k, k])),
      critical: Array.from({ length: 32 }, (_, k) => 'urn:fixture:' + k)
    }
  ].entries()) {
    add('validateOutputExtensions', 'unknown-' + i, () => p.validateOutputExtensions(value))
    add('validateOutputExtensions', 'supported-' + i, () =>
      p.validateOutputExtensions(value, ['urn:fixture:a'])
    )
  }
}

function schemaBoundaryCases(add, s, scalars, boundaries) {
  for (const [family, getTools] of [
    ['portable', () => s],
    ['owned', () => s.createOwnedRecordSchema()]
  ]) {
    const factories = {
      text: t => t.text,
      hex: t => t.hex,
      identity: t => t.identity,
      bytes: t => t.bytes,
      json: t => t.json,
      jsonMap: t => t.jsonMap,
      chain: t => t.chain,
      outpoint: t => t.outpoint,
      bool: t => t.bool,
      iri: t => t.iri,
      requestId: t => t.requestId,
      u32: t => t.u32,
      u64: t => t.u64,
      nullable: t => t.nullable(t.u32),
      array: t => t.array(t.u32, 2, 1),
      object: t =>
        t.fixedObject({ kind: t.literal('value'), value: t.u32 }, { note: t.nullable(t.text) }),
      tagged: t =>
        t.tagged('kind', {
          left: t.fixedObject({ kind: t.literal('left'), count: t.u32 }),
          right: t.fixedObject({ kind: t.literal('right'), label: t.text })
        })
    }
    const samples = [
      ...scalars,
      ...boundaries,
      { network: 'test', genesisHash: '11'.repeat(32) },
      {
        chain: { network: 'test', genesisHash: '11'.repeat(32) },
        txid: '22'.repeat(32),
        outputIndex: 0
      },
      [1],
      [1, 2],
      [1, 2, 3],
      [-1],
      [1.5],
      { kind: 'value', value: 7 },
      { kind: 'value', value: 7, note: null },
      { kind: 'value', value: 7, note: 'current' },
      { kind: 'value', value: 7, extra: true },
      { kind: 'value', value: 7, note: 1 },
      { kind: 'value', value: -1 },
      { kind: 'left', count: 7 },
      { kind: 'right', label: 'text' },
      { kind: 'right', label: 7 },
      { kind: 'toString' },
      { kind: 7 },
      'urn:fixture:a',
      'relative',
      'a'.repeat(15),
      'a'.repeat(16),
      'a'.repeat(128),
      'a'.repeat(129),
      'a'.repeat(15) + '\n'
    ]
    for (const [name, factory] of Object.entries(factories)) {
      for (const [i, value] of samples.entries()) {
        add('schema-' + family + '-' + name, 'direct-' + i, () =>
          factory(getTools())(structuredClone(value))
        )
        add('schema-' + family + '-' + name, 'normalized-' + i, () => {
          const tools = getTools()
          return tools.normalized(structuredClone(value), factory(tools))
        })
      }
    }
  }
}

function observationLimits(j, scenario) {
  if (scenario === 'limits') return Object.fromEntries(Object.entries(j.OUTPUT_JSON_LIMITS))
  if (scenario === 'bounded') return { bytes: 1 }
  return undefined
}
function observedOwnerCases(add, j, owners) {
  for (const name of owners) {
    for (const scenario of ['record', 'array', 'late-invalid', 'bounded', 'limits']) {
      add(name, 'observations-' + scenario, () => {
        const trace = [],
          child = { value: 1 }
        const target = scenario === 'array' ? [child, true] : { z: true, a: child }
        if (scenario === 'late-invalid') target.z = undefined
        const input = new Proxy(target, {
          ownKeys(value) {
            trace.push(['keys'])
            return Reflect.ownKeys(value)
          },
          getOwnPropertyDescriptor(value, key) {
            trace.push(['descriptor', String(key)])
            if (key === 'z' || key === '1') child.value = 9
            return Reflect.getOwnPropertyDescriptor(value, key)
          },
          get(value, key, receiver) {
            trace.push(['get', String(key)])
            return Reflect.get(value, key, receiver)
          }
        })
        const bound = observationLimits(j, scenario)
        const limitsProxy =
          bound &&
          new Proxy(bound, {
            get(value, key, receiver) {
              trace.push(['limit', String(key)])
              return Reflect.get(value, key, receiver)
            }
          })
        const outcome = observation(() => j[name](input, limitsProxy))
        return { outcome, trace, after: child.value }
      })
    }
  }
}

function calls({ json: j, protocol: p, schema: s }) {
  const result = []
  const add = (group, id, run) =>
    result.push({ group, id: group + '/' + id, observe: () => observation(run) })
  const owners = new Set([
    'canonicalOutputJSON',
    'ownOutputJSON',
    'ownOutputJSONValue',
    'canonicalOutputJSONWithInlineStrings',
    'ownOutputJSONWithInlineStrings',
    'canonicalOutputJSONWithInlineRecords',
    'ownOutputJSONWithInlineRecords',
    'ownOutputJSONForSchema',
    'ownOutputJSONWithCountedRecords',
    'canonicalOutputJSONWithDirectRecords'
  ])
  const readers = new Set([
    'parseOutputJSON',
    'inspectOutputJSONEncoding',
    'parseOutputJSONWithStringRecords',
    'inspectOutputJSONEncodingWithScalarRecords',
    'parseOutputJSONWithOwnedRecords',
    'inspectOutputJSONEncodingWithOwnedRecords'
  ])
  const limits = [undefined, { bytes: 16 }, { depth: 1 }, { arrayElements: 1 }, { mapKeys: 1 }]
  const boundaries = [
    null,
    true,
    0,
    -0,
    'a',
    'é😀',
    '"\n',
    [],
    [1],
    [1, 2],
    {},
    { a: 'a' },
    { a: 1 },
    { a: [1] },
    [[], { value: 'x' }],
    { ['\u0000']: '\n' },
    { z: 1, a: 2 },
    { ['"']: '\\' }
  ]
  for (const point of [0, 8, 9, 10, 12, 13, 31, 34, 92, 127, 128, 2047, 2048, 0xffff, 0x10000]) {
    const text = String.fromCodePoint(point)
    boundaries.push(text, { [text]: text })
  }
  const identity = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const scalars = [
    undefined,
    null,
    false,
    true,
    0,
    -1,
    1,
    0.5,
    4294967295,
    4294967296,
    '',
    '0',
    '1',
    '01',
    '-1',
    '1e2',
    '1\n',
    '18446744073709551615',
    '18446744073709551616',
    '11'.repeat(32),
    'AA'.repeat(32),
    '11'.repeat(32) + '\n',
    identity,
    identity.toUpperCase(),
    '04' + '11'.repeat(32),
    '02' + 'ff'.repeat(32),
    '03' + '00'.repeat(32),
    'AA==',
    'AQI=',
    'AQID',
    'AA=',
    'A===',
    'AA==\n',
    '\uD800'
  ]
  jsonInputCases(add, j, owners, readers, limits)
  jsonBoundaryCases(add, j, owners, readers, boundaries)
  reportedByteLengthCases(add, j)
  protocolBoundaryCases(add, p, scalars)
  schemaBoundaryCases(add, s, scalars, boundaries)
  observedOwnerCases(add, j, owners)
  return result
}

// Count native lexical/decoding work while retaining every native return value.
// Measurements are synchronous, restored before any assertion, and independent
// of CPU load or mutation instrumentation's JavaScript bookkeeping. Budgets allow
// fewer operations as well as modest overhead; they do not require an exact trace.
function nativeWork(run) {
  const restore = [],
    counts = { calls: 0, parses: 0 }
  const tracked = [
    [String.prototype, ['includes', 'indexOf', 'slice']],
    [RegExp.prototype, ['exec']],
    [JSON, ['parse']]
  ]
  try {
    for (const [owner, names] of tracked)
      for (const name of names) {
        const original = owner[name]
        owner[name] = function (...args) {
          counts.calls++
          if (owner === JSON) counts.parses++
          return Reflect.apply(original, this, args)
        }
        restore.push(() => {
          owner[name] = original
        })
      }
    const value = run()
    return { value, ...counts }
  } finally {
    for (const reset of restore) reset()
  }
}
function workloads() {
  const result = []
  const add = (name, id, input) => result.push({ name, id: name + '/' + id, input })
  for (const [label, scalar] of [
    ['ascii', 'native punctuation,:{}[]'],
    ['unicode', 'é😀'],
    ['empty', '']
  ]) {
    const text = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 24 }, (_, i) => ['field' + String(i).padStart(2, '0'), scalar])
      )
    )
    for (const name of [
      'parseOutputJSONWithStringRecords',
      'parseOutputJSONWithOwnedRecords',
      'inspectOutputJSONEncodingWithScalarRecords',
      'inspectOutputJSONEncodingWithOwnedRecords'
    ])
      add(name, label, text)
  }
  for (const [label, scalar] of [
    ['null', null],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['positive', 9007199254740991],
    ['negative', -9007199254740991]
  ]) {
    const text = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 24 }, (_, i) => ['field' + String(i).padStart(2, '0'), scalar])
      )
    )
    for (const name of [
      'parseOutputJSONWithOwnedRecords',
      'inspectOutputJSONEncodingWithScalarRecords',
      'inspectOutputJSONEncodingWithOwnedRecords'
    ])
      add(name, label, text)
  }
  return result
}

module.exports = { calls, nativeWork, workloads }
