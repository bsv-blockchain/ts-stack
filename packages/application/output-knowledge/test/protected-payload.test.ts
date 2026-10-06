import { expect, it } from '@jest/globals'
import {
  createCipheriv,
  createSecretKey,
  generateKeyPairSync,
  createDecipheriv,
  hkdfSync
} from 'node:crypto'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { canonicalOutputJSON, decodeOutputBytes, type OutputJSONObject } from '@bsv/sdk'

// Public synthetic test keys only.
const keys = new Map([
  ['key-a', createSecretKey(Buffer.alloc(32, 0x31))],
  ['key-b', createSecretKey(Buffer.alloc(32, 0x52))]
])
const binding = { service: 'fixture-private', namespace: 'publisher', record: 'a', revision: '2' }
const custody = {
  resolve: (id: string) => {
    const key = keys.get(id)
    if (!key) throw new Error('fixture missing key')
    return key
  }
}
const codec = () => new NodeProtectedPayloadCodec(custody, 'key-a', 128)

it('round trips binary and empty payloads with independent authenticated envelopes', () => {
  const value = Uint8Array.from([0, 1, 2, 128, 255])
  const first = codec().seal(binding, value)
  const second = codec().seal(binding, value)
  expect(first).not.toEqual(second)
  expect(codec().open(binding, first)).toEqual(value)
  expect(codec().open(binding, codec().seal(binding, new Uint8Array()))).toEqual(new Uint8Array())
})

it('retains old-key recovery while writing under a separately selected new key', () => {
  const envelope = codec().seal(binding, Uint8Array.of(7))
  const rotated = new NodeProtectedPayloadCodec(custody, 'key-b', 128)
  expect(rotated.open(binding, envelope)).toEqual(Uint8Array.of(7))
  expect(rotated.seal(binding, Uint8Array.of(8)).keyId).toBe('key-b')
})

it.each(['service', 'namespace', 'record', 'revision'])(
  'authenticates the complete %s binding',
  field => {
    const envelope = codec().seal(binding, Uint8Array.of(7))
    expect(() => codec().open({ ...binding, [field]: 'different' }, envelope)).toThrow(
      'authentication failed'
    )
  }
)

it.each(['salt', 'nonce', 'ciphertext', 'tag'])('rejects modified %s bytes', field => {
  const envelope = codec().seal(binding, Uint8Array.of(7))
  const changed = Buffer.from(envelope[field as 'salt' | 'nonce' | 'ciphertext' | 'tag'], 'base64')
  changed[0] ^= 1
  expect(() => codec().open(binding, { ...envelope, [field]: changed.toString('base64') })).toThrow(
    'authentication failed'
  )
})

it('authenticates the retained key label even when two labels resolve to the same key', () => {
  const local = new NodeProtectedPayloadCodec({ resolve: () => keys.get('key-a')! }, 'first', 128)
  const envelope = local.seal(binding, Uint8Array.of(1))
  expect(() => local.open(binding, { ...envelope, keyId: 'second' })).toThrow(
    'authentication failed'
  )
})

it('requires exact nonce and authentication tag sizes', () => {
  const envelope = codec().seal(binding, Uint8Array.of(7))
  for (const [field, length] of [
    ['salt', 31],
    ['salt', 33],
    ['nonce', 11],
    ['nonce', 13],
    ['tag', 15],
    ['tag', 17]
  ] as const)
    expect(() =>
      codec().open(binding, { ...envelope, [field]: Buffer.alloc(length).toString('base64') })
    ).toThrow()
})

it('never substitutes a new key when retained custody becomes unavailable', () => {
  let available = true
  const local = new NodeProtectedPayloadCodec(
    {
      resolve: () => {
        if (!available) throw new Error('private-provider-details')
        return keys.get('key-a')!
      }
    },
    'key-a',
    128
  )
  const envelope = local.seal(binding, Uint8Array.of(1))
  available = false
  for (const work of [
    () => local.open(binding, envelope),
    () => local.seal(binding, Uint8Array.of(2))
  ]) {
    expect(work).toThrow('Protected payload custody is unavailable')
    try {
      work()
    } catch (error) {
      expect(String(error)).not.toContain('private-provider-details')
    }
  }
})

it.each([0, -1, 1.5, Number.NaN, 2097153])('rejects invalid capacity %s', maximum => {
  expect(() => new NodeProtectedPayloadCodec(custody, 'key-a', maximum)).toThrow('capacity')
})

it('enforces the exact byte boundary on both encryption and decryption', () => {
  const local = new NodeProtectedPayloadCodec(custody, 'key-a', 3)
  expect(local.open(binding, local.seal(binding, Uint8Array.of(1, 2, 3)))).toEqual(
    Uint8Array.of(1, 2, 3)
  )
  expect(() => local.seal(binding, Uint8Array.of(1, 2, 3, 4))).toThrow('capacity')
  expect(() => local.open(binding, codec().seal(binding, Uint8Array.of(1, 2, 3, 4)))).toThrow()
})

it('rejects wrong key kinds, wrong key sizes and missing keys', () => {
  const { publicKey } = generateKeyPairSync('ed25519')
  for (const key of [createSecretKey(Buffer.alloc(16)), publicKey, undefined])
    expect(() => new NodeProtectedPayloadCodec({ resolve: () => key! }, 'key-a')).toThrow(
      'custody is unavailable'
    )
  expect(() => new NodeProtectedPayloadCodec(custody, 'missing')).toThrow('custody is unavailable')
})

it('owns secret bytes and binding before invoking custody callbacks', () => {
  const value = Uint8Array.of(1)
  const scope = { ...binding }
  const local = new NodeProtectedPayloadCodec(
    {
      resolve: () => {
        value[0] = 2
        scope.record = 'changed'
        return keys.get('key-a')!
      }
    },
    'key-a',
    128
  )
  value[0] = 1
  scope.record = binding.record
  const envelope = local.seal(scope, value)
  expect(codec().open(binding, envelope)).toEqual(Uint8Array.of(1))
})

it('rejects accessors without invoking them, oversized context, primitive bindings and extra fields', () => {
  let touched = false
  const accessor = {
    get secret() {
      touched = true
      return 'private'
    }
  }
  expect(() => codec().seal(accessor, Uint8Array.of(1))).toThrow()
  expect(() => codec().open(binding, accessor)).toThrow()
  expect(touched).toBe(false)
  expect(() => codec().seal({ value: 'x'.repeat(65536) }, Uint8Array.of(1))).toThrow()
  for (const scope of [null, [], 'binding'])
    expect(() => codec().seal(scope as unknown as OutputJSONObject, Uint8Array.of(1))).toThrow()
  expect(() =>
    codec().open(binding, { ...codec().seal(binding, Uint8Array.of(1)), extra: true })
  ).toThrow()
})

it('rejects malformed versions, labels, byte encodings and nonbyte input', () => {
  for (const label of ['', 'private key', 'a'.repeat(129)])
    expect(() => new NodeProtectedPayloadCodec(custody, label)).toThrow()
  const envelope = codec().seal(binding, Uint8Array.of(1))
  for (const patch of [
    { format: 'future' },
    { nonce: 'bad' },
    { ciphertext: 4 },
    { tag: '' },
    { keyId: 'bad label' }
  ])
    expect(() => codec().open(binding, { ...envelope, ...patch })).toThrow()
  expect(() => codec().seal(binding, [1] as unknown as Uint8Array)).toThrow()
})

it('can be decrypted independently using the documented local framing and associated data', () => {
  const local = codec(),
    value = Uint8Array.of(0, 7, 128, 255)
  const envelope = local.seal(binding, value)
  expect(envelope.format).toBe('output-protected-payload/1')
  expect(envelope.keyId).toBe('key-a')
  const salt = Buffer.from(envelope.salt, 'base64'),
    nonce = Buffer.from(envelope.nonce, 'base64'),
    tag = Buffer.from(envelope.tag, 'base64')
  expect(salt).toHaveLength(32)
  expect(nonce).toHaveLength(12)
  expect(tag).toHaveLength(16)
  const key = hkdfSync('sha256', keys.get('key-a')!, salt, 'output-protected-payload/1', 32)
  const decrypt = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  decrypt.setAAD(
    Buffer.from(
      canonicalOutputJSON({ format: 'output-protected-payload/1', keyId: 'key-a', binding })
    )
  )
  decrypt.setAuthTag(tag)
  expect(
    Buffer.concat([decrypt.update(Buffer.from(envelope.ciphertext, 'base64')), decrypt.final()])
  ).toEqual(Buffer.from(value))
})

it('accepts the minimum installed capacity and preserves clear failure classification', () => {
  const local = new NodeProtectedPayloadCodec(custody, 'key-a', 1)
  expect(local.open(binding, local.seal(binding, Uint8Array.of(1)))).toEqual(Uint8Array.of(1))
  expect(() => local.seal(binding, new Uint8Array(2))).toThrow(
    expect.objectContaining({
      code: 'limited',
      message: 'Protected payload exceeds its reserved capacity'
    })
  )
  expect(() => local.seal(binding, [1] as unknown as Uint8Array)).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Protected payload must contain bytes' })
  )
  expect(() => new NodeProtectedPayloadCodec(custody, 'key-a', 0)).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Invalid protected payload capacity' })
  )
})

it.each(['$key', 'key$', ' key', 'key ', 'a'.repeat(129)])(
  'validates custody labels independently of key availability: %s',
  keyId => {
    expect(
      () => new NodeProtectedPayloadCodec({ resolve: () => keys.get('key-a')! }, keyId)
    ).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Invalid protected payload key label' })
    )
  }
)

it('rejects a shaped object masquerading as a custody key before cryptographic work', () => {
  const fake = { type: 'secret', symmetricKeySize: 32 }
  expect(
    () =>
      new NodeProtectedPayloadCodec(
        { resolve: () => fake as unknown as ReturnType<typeof createSecretKey> },
        'key-a'
      )
  ).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Protected payload custody is unavailable'
    })
  )
})

it('distinguishes malformed framing from a well-shaped envelope that fails authentication', () => {
  const envelope = codec().seal(binding, Uint8Array.of(7))
  expect(() =>
    codec().open(binding, { ...envelope, nonce: Buffer.alloc(11).toString('base64') })
  ).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Invalid protected payload framing' })
  )
  expect(() => codec().open(binding, { ...envelope, format: 'future' })).toThrow(
    expect.objectContaining({
      code: 'unsupported',
      message: 'Unsupported protected payload format'
    })
  )
  expect(() =>
    codec().open(binding, { ...envelope, tag: Buffer.alloc(16).toString('base64') })
  ).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Protected payload authentication failed'
    })
  )
  expect(() => codec().seal([] as unknown as OutputJSONObject, Uint8Array.of(1))).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Protected payload binding must be an object'
    })
  )
})

it('reads independently encrypted original Buffer-key envelopes through both readers', () => {
  const format = 'output-protected-payload/1' as const
  const salt = Buffer.alloc(32, 0x67),
    nonce = Buffer.alloc(12, 0x89),
    value = Buffer.from([0, 7, 128, 255])
  const derived = Buffer.from(hkdfSync('sha256', Buffer.alloc(32, 0x31), salt, format, 32))
  try {
    const cipher = createCipheriv('aes-256-gcm', derived, nonce, { authTagLength: 16 })
    cipher.setAAD(Buffer.from(canonicalOutputJSON({ format, keyId: 'key-a', binding })))
    const envelope = {
      format,
      keyId: 'key-a',
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      ciphertext: Buffer.concat([cipher.update(value), cipher.final()]).toString('base64'),
      tag: cipher.getAuthTag().toString('base64')
    }
    expect(codec().open(binding, envelope)).toEqual(Uint8Array.from(value))
    expect(codec().openSerialized(binding, JSON.stringify(envelope), 512)).toEqual(
      Uint8Array.from(value)
    )
  } finally {
    derived.fill(0)
  }
})

it.each([
  ['salt', 32],
  ['nonce', 12],
  ['tag', 16],
  ['ciphertext', 128]
] as const)(
  'retains SDK canonical base64 refusals for %s through both readers',
  (field, maximum) => {
    const envelope = codec().seal(binding, Uint8Array.of(7))
    for (const encoded of [
      'A',
      'AA',
      'AAA',
      'AA===',
      '====',
      'AA-_',
      'AA==\n',
      ' A==',
      'AB==',
      'AAB=',
      '=AAA',
      'AAAA====',
      Buffer.alloc(maximum + 1).toString('base64'),
      Buffer.alloc(maximum + 3).toString('base64')
    ]) {
      let expected: unknown
      try {
        decodeOutputBytes(encoded, maximum)
      } catch (error) {
        expected = error
      }
      // The independent protocol oracle must reject each tested representation.
      expect(expected).toBeDefined()
      const { code, message } = expected as { code: string; message: string }
      const malformed = { ...envelope, [field]: encoded }
      expect(() => codec().open(binding, malformed)).toThrow(
        expect.objectContaining({ code, message })
      )
      expect(() => codec().openSerialized(binding, JSON.stringify(malformed), 512)).toThrow(
        expect.objectContaining({ code, message })
      )
    }
  }
)
