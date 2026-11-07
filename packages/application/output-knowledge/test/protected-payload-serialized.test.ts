import { expect, it, jest } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { parseOutputJSON, type OutputJSONObject } from '@bsv/sdk'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'

const binding = { service: 'synthetic', record: 'one', revision: '1' }
const key = createSecretKey(Buffer.alloc(32, 0x39))
const bound = Math.ceil(128 / 3) * 4 + 1024
const make = () => new NodeProtectedPayloadCodec({ resolve: () => key }, 'key-a', 128)
const failure = (work: () => unknown) => {
  try {
    work()
  } catch (error) {
    const value = error as { code: string; message: string }
    return { code: value.code, message: value.message }
  }
  throw new Error('Expected a rejected synthetic input')
}

it('preserves plaintext across canonical, reordered, spaced and escaped serialized envelopes', () => {
  const codec = make(),
    bytes = Uint8Array.of(0, 128, 255),
    envelope = codec.seal(binding, bytes)
  const reversed = Object.fromEntries(Object.entries(envelope).reverse())
  for (const source of [
    JSON.stringify(envelope),
    JSON.stringify(reversed, null, 2),
    JSON.stringify(envelope).replace('key-a', '\\u006bey-a')
  ]) {
    expect(codec.openSerialized(binding, source, bound)).toEqual(bytes)
    expect(codec.openSerialized(binding, source, Buffer.byteLength(source))).toEqual(
      codec.open(binding, parseOutputJSON(source))
    )
  }
  expect(
    codec.openSerialized(binding, JSON.stringify(codec.seal(binding, new Uint8Array())), bound)
  ).toEqual(new Uint8Array())
})

it('enforces serialized capacity independently of exact plaintext capacity', () => {
  const codec = make(),
    source = JSON.stringify(codec.seal(binding, new Uint8Array(128)))
  expect(codec.openSerialized(binding, source, Buffer.byteLength(source))).toHaveLength(128)
  expect(
    failure(() => codec.openSerialized(binding, source, Buffer.byteLength(source) - 1)).code
  ).toBe('limited')
  for (const capacity of [0, -1, 1.5, NaN, Infinity, bound + 1])
    expect(failure(() => codec.openSerialized(binding, source, capacity))).toEqual({
      code: 'invalid',
      message: 'Invalid protected payload envelope capacity'
    })
  for (const value of [null, {}, [], Uint8Array.of(1), 1])
    expect(failure(() => codec.openSerialized(binding, value as unknown as string, bound))).toEqual(
      { code: 'invalid', message: 'Protected payload must contain serialized JSON' }
    )
})

it('rejects decoded duplicate keys, trailing data, unpaired Unicode and a BOM before custody', () => {
  const resolve = jest.fn(() => key),
    codec = new NodeProtectedPayloadCodec({ resolve }, 'key-a', 128)
  const source = JSON.stringify(codec.seal(binding, Uint8Array.of(1)))
  for (const text of [
    '{"keyId":"key-a",' + source.slice(1),
    '{"\\u006beyId":"key-a",' + source.slice(1),
    source + '{}',
    '\ufeff' + source,
    source.replace('key-a', '\\ud800'),
    '{"format":'
  ]) {
    resolve.mockClear()
    expect(() => codec.openSerialized(binding, text, bound)).toThrow()
    expect(resolve).not.toHaveBeenCalled()
  }
})

it('retains legacy error classification and order for malformed shapes and field types', () => {
  const codec = make(),
    envelope = codec.seal(binding, Uint8Array.of(7))
  for (const value of [
    null,
    [],
    'envelope',
    1,
    false,
    {},
    { ...envelope, extra: true },
    { ...envelope, format: 'future' },
    { ...envelope, format: 'future', ciphertext: [] },
    { ...envelope, keyId: '' },
    { ...envelope, keyId: 'bad label' },
    { ...envelope, ciphertext: 4 },
    { ...envelope, salt: null },
    { ...envelope, nonce: Buffer.alloc(11).toString('base64') },
    { ...envelope, tag: '' },
    { ...envelope, ciphertext: 'bad' }
  ]) {
    const source = JSON.stringify(value)
    expect(failure(() => codec.openSerialized(binding, source, bound))).toEqual(
      failure(() => codec.open(binding, parseOutputJSON(source, { bytes: bound })))
    )
  }
})

it('reauthenticates every ciphertext, binding and retained label and never caches custody', () => {
  let available = true
  const resolve = jest.fn(() => {
    if (!available) throw new Error('private-provider-details')
    return key
  })
  const codec = new NodeProtectedPayloadCodec({ resolve }, 'key-a', 128)
  const envelope = codec.seal(binding, Uint8Array.of(7)),
    source = JSON.stringify(envelope)
  resolve.mockClear()
  expect(codec.openSerialized(binding, source, bound)).toEqual(Uint8Array.of(7))
  expect(codec.openSerialized(binding, source, bound)).toEqual(Uint8Array.of(7))
  expect(resolve).toHaveBeenCalledTimes(2)
  for (const field of ['salt', 'nonce', 'ciphertext', 'tag'] as const) {
    const bytes = Buffer.from(envelope[field], 'base64')
    bytes[0] ^= 1
    expect(
      failure(() =>
        codec.openSerialized(
          binding,
          JSON.stringify({ ...envelope, [field]: bytes.toString('base64') }),
          bound
        )
      )
    ).toEqual({ code: 'unavailable', message: 'Protected payload authentication failed' })
  }
  expect(() => codec.openSerialized({ ...binding, record: 'other' }, source, bound)).toThrow(
    'authentication failed'
  )
  expect(() =>
    codec.openSerialized(binding, JSON.stringify({ ...envelope, keyId: 'key-b' }), bound)
  ).toThrow('authentication failed')
  available = false
  expect(failure(() => codec.openSerialized(binding, source, bound))).toEqual({
    code: 'unavailable',
    message: 'Protected payload custody is unavailable'
  })
  for (const bad of [null, [], 'binding'])
    expect(
      failure(() => codec.openSerialized(bad as unknown as OutputJSONObject, source, bound))
    ).toEqual({ code: 'invalid', message: 'Protected payload binding must be an object' })
})

it('preserves subclass and instance object-reader dispatch with one capture before parsing', () => {
  const calls: unknown[] = []
  class CustomReader extends NodeProtectedPayloadCodec {
    override open(scope: OutputJSONObject, input: unknown): Uint8Array {
      calls.push(input)
      return super.open(scope, input)
    }
  }
  const subclass = new CustomReader({ resolve: () => key }, 'key-a', 128)
  const source = JSON.stringify(subclass.seal(binding, Uint8Array.of(7)))
  expect(subclass.openSerialized(binding, source, bound)).toEqual(Uint8Array.of(7))
  expect(calls).toHaveLength(1)
  expect(Object.getPrototypeOf(calls[0])).toBeNull()

  const instance = make()
  let captures = 0
  const reader = jest.fn(function (
    this: NodeProtectedPayloadCodec,
    scope: OutputJSONObject,
    input: unknown
  ) {
    expect(this).toBe(instance)
    return NodeProtectedPayloadCodec.prototype.open.call(this, scope, input)
  })
  Object.defineProperty(instance, 'open', {
    get: () => {
      captures++
      return reader
    }
  })
  expect(instance.openSerialized(binding, source, bound)).toEqual(Uint8Array.of(7))
  expect(captures).toBe(1)
  expect(reader).toHaveBeenCalledTimes(1)
  expect(Object.getPrototypeOf(reader.mock.calls[0][1])).toBeNull()
  expect(() =>
    instance.openSerialized(binding, '{"keyId":"key-a",' + source.slice(1), bound)
  ).toThrow('Duplicate')
  expect(captures).toBe(2)
  expect(reader).toHaveBeenCalledTimes(1)

  const prototypeReader = jest.spyOn(NodeProtectedPayloadCodec.prototype, 'open')
  try {
    expect(make().openSerialized(binding, source, bound)).toEqual(Uint8Array.of(7))
    expect(prototypeReader).toHaveBeenCalledTimes(1)
  } finally {
    prototypeReader.mockRestore()
  }
})

it('checks every fresh owned string field and exact six-field membership before payload decoding', () => {
  const codec = make(),
    envelope = codec.seal(binding, Uint8Array.of(3, 9))
  const fields = ['format', 'keyId', 'salt', 'nonce', 'ciphertext', 'tag'] as const
  for (const field of fields) {
    const missing: Record<string, unknown> = { ...envelope }
    delete missing[field]
    const renamed = { ...missing, unknown: envelope[field] }
    for (const value of [
      missing,
      renamed,
      ...[null, false, 1, [], {}].map(value => ({ ...envelope, [field]: value }))
    ]) {
      const source = JSON.stringify(value)
      expect(failure(() => codec.openSerialized(binding, source, bound))).toEqual(
        failure(() => codec.open(binding, parseOutputJSON(source, { bytes: bound })))
      )
    }
  }
  const source = JSON.stringify(envelope)
  expect(codec.openSerialized(binding, source, bound)).toEqual(Uint8Array.of(3, 9))
  expect(
    failure(() => codec.openSerialized(binding, JSON.stringify({ ...envelope, tag: false }), bound))
  ).toEqual(
    failure(() =>
      codec.open(
        binding,
        parseOutputJSON(JSON.stringify({ ...envelope, tag: false }), { bytes: bound })
      )
    )
  )
  expect(codec.openSerialized(binding, source, bound)).toEqual(Uint8Array.of(3, 9))
})

it('refuses string-only framing impostors before consulting custody', () => {
  const resolve = jest.fn(() => key)
  const codec = new NodeProtectedPayloadCodec({ resolve }, 'key-a', 128)
  const envelope = codec.seal(binding, Uint8Array.of(5))
  const { tag, ...withoutTag } = envelope
  const impostors = [
    { ...envelope, format: 'future' },
    { ...envelope, keyId: 'bad label' },
    { ...envelope, extra: 'string' },
    ...['__proto__', 'constructor', 'toString'].map(name =>
      Object.fromEntries([...Object.entries(withoutTag), [name, tag]])
    )
  ]
  for (const value of impostors) {
    const source = JSON.stringify(value)
    resolve.mockClear()
    expect(failure(() => codec.openSerialized(binding, source, bound))).toEqual(
      failure(() => codec.open(binding, parseOutputJSON(source, { bytes: bound })))
    )
    expect(resolve).not.toHaveBeenCalled()
  }
  resolve.mockClear()
  expect(codec.openSerialized(binding, JSON.stringify(envelope), bound)).toEqual(Uint8Array.of(5))
  expect(resolve).toHaveBeenCalledTimes(1)
})
const canonicalSerializedEnvelope = (value: object) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => {
        if (a === b) return 0
        return a < b ? -1 : 1
      })
    )
  )

it('authenticates canonical six-field text at exact byte boundaries without retaining custody', () => {
  let available = true
  const resolve = jest.fn(() => {
    if (!available) throw new Error('synthetic unavailable key')
    return key
  })
  const codec = new NodeProtectedPayloadCodec({ resolve }, 'key-a', 128)
  for (const bytes of [
    new Uint8Array(),
    Uint8Array.of(0),
    Uint8Array.of(0, 255),
    new Uint8Array(128)
  ]) {
    const envelope = codec.seal(binding, bytes),
      source = canonicalSerializedEnvelope(envelope)
    expect(codec.openSerialized(binding, source, source.length)).toEqual(bytes)
    expect(codec.openSerialized(binding, source, source.length)).toEqual(
      codec.open(binding, parseOutputJSON(source))
    )
    expect(failure(() => codec.openSerialized(binding, source, source.length - 1)).code).toBe(
      'limited'
    )
  }
  const envelope = codec.seal(binding, Uint8Array.of(7)),
    source = canonicalSerializedEnvelope(envelope)
  resolve.mockClear()
  expect(codec.openSerialized(binding, source, source.length)).toEqual(Uint8Array.of(7))
  expect(resolve).toHaveBeenCalledTimes(1)
  available = false
  expect(failure(() => codec.openSerialized(binding, source, source.length))).toEqual({
    code: 'unavailable',
    message: 'Protected payload custody is unavailable'
  })
  available = true
  const changed = Buffer.from(envelope.tag, 'base64')
  changed[0] ^= 1
  expect(
    failure(() =>
      codec.openSerialized(
        binding,
        canonicalSerializedEnvelope({ ...envelope, tag: changed.toString('base64') }),
        bound
      )
    )
  ).toEqual({ code: 'unavailable', message: 'Protected payload authentication failed' })
  expect(codec.openSerialized(binding, source, source.length)).toEqual(Uint8Array.of(7))
})

it('retains duplicate-aware parser and scalar refusal precedence around canonical text', () => {
  const codec = make(),
    envelope = codec.seal(binding, Uint8Array.of(7))
  const source = canonicalSerializedEnvelope(envelope)
  for (const text of [
    source + '\n',
    source + '\r\n',
    ' ' + source,
    source.replace('key-a', '\\u006bey-a'),
    source.replace('"format":', '"format":"output-protected-payload/1","format":'),
    source.replace('"keyId":', '"\\u006beyId":"key-a","keyId":'),
    source.replace('"keyId":"key-a"', '"keyId":"bad label"'),
    source.replace('"keyId":"key-a"', '"keyId":"\\ud800"'),
    source.replace('"format":"output-protected-payload/1"', '"format":"future"'),
    source.slice(0, -1) + ',"extra":"x"}',
    source + '{}',
    '\ufeff' + source,
    ...['salt', 'nonce', 'ciphertext', 'tag'].flatMap(field =>
      ['=', '====', 'AB==', 'AAB=', 'AA==\n'].map(value =>
        canonicalSerializedEnvelope({ ...envelope, [field]: value })
      )
    )
  ]) {
    const oracle = () => codec.open(binding, parseOutputJSON(text, { bytes: bound }))
    try {
      const expected = oracle()
      expect(codec.openSerialized(binding, text, bound)).toEqual(expected)
    } catch {
      expect(failure(() => codec.openSerialized(binding, text, bound))).toEqual(failure(oracle))
    }
  }
})

it('delivers a fresh null-prototype canonical envelope to the current captured reader', () => {
  const codec = make(),
    envelope = codec.seal(binding, Uint8Array.of(7))
  const source = canonicalSerializedEnvelope(envelope)
  const received: unknown[] = []
  let captures = 0
  const reader = jest.fn((scope: OutputJSONObject, owned: unknown) => {
    received.push(owned)
    expect(Object.getPrototypeOf(owned)).toBeNull()
    expect(Object.keys(owned as object)).toEqual([
      'ciphertext',
      'format',
      'keyId',
      'nonce',
      'salt',
      'tag'
    ])
    return NodeProtectedPayloadCodec.prototype.open.call(codec, scope, owned)
  })
  Object.defineProperty(codec, 'open', {
    get: () => {
      captures++
      return reader
    }
  })
  expect(codec.openSerialized(binding, source, bound)).toEqual(Uint8Array.of(7))
  expect(codec.openSerialized(binding, source, bound)).toEqual(Uint8Array.of(7))
  expect(captures).toBe(2)
  expect(received[0]).not.toBe(received[1])
  expect(() => codec.openSerialized(binding, source + '{}', bound)).toThrow()
  expect(captures).toBe(3)
  expect(reader).toHaveBeenCalledTimes(2)
})
