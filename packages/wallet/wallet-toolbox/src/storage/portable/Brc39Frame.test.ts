import { createCipheriv, createDecipheriv } from 'node:crypto'
import { AESGCMDecrypt } from '@bsv/sdk/primitives/AESGCM'
import { Brc39StreamFrame, BRC39_STREAM_DEFAULT_KDF, encodeBrc39StreamPrefix } from './Brc39Frame'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

const policy = {
  maximumFileBytes: 1048576,
  maximumChunkBytes: 65536,
  maximumIterations: 9,
  maximumMemoryKiB: 262144,
  maximumParallelism: 4
}
const salt = Uint8Array.from({ length: 32 }, (_, index) => index)
const nonce = Uint8Array.from({ length: 32 }, (_, index) => 100 + index)
// Independent fixed envelope oracle: this deliberately does not call the encoder.
function file(ciphertext = Buffer.from('synthetic ciphertext'), saltLength = 32, nonceLength = 32): Uint8Array {
  const prefix = Buffer.alloc(33 + saltLength + nonceLength)
  prefix.write('WDAT')
  prefix.set([1, 1, 38, 1, 0, saltLength, nonceLength], 4)
  prefix.writeUInt32BE(7, 11)
  prefix.writeUInt32BE(131072, 15)
  prefix[19] = 1
  prefix[20] = 32
  prefix.fill(42, 33)
  return new Uint8Array(Buffer.concat([prefix, ciphertext, Buffer.alloc(16, 99)]))
}
function consume(bytes: Uint8Array, width: number) {
  const frame = new Brc39StreamFrame({ ...policy, maximumChunkBytes: width })
  const output: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += width)
    output.push(...frame.accept(bytes.subarray(offset, offset + width)))
  const header = frame.header()
  const end = frame.finish()
  return { header, end, output, ciphertext: Buffer.concat(output) }
}

test('canonical prefix matches an independent envelope oracle and preserves exact stronger parameters', () => {
  const prefix = encodeBrc39StreamPrefix(BRC39_STREAM_DEFAULT_KDF, salt, nonce, policy)
  const expected = Buffer.from(file().slice(0, 97))
  expected.set(salt, 33)
  expected.set(nonce, 65)
  expect(Buffer.from(prefix)).toEqual(expected)
  const stronger = encodeBrc39StreamPrefix({ iterations: 9, memoryKiB: 262144, parallelism: 4 }, salt, nonce, policy)
  expect(new DataView(stronger.buffer).getUint32(11)).toBe(9)
  expect(new DataView(stronger.buffer).getUint32(15)).toBe(262144)
  expect(stronger[19]).toBe(4)
  salt[0] ^= 1
  expect(prefix[33]).toBe(0)
  salt[0] ^= 1
})
test.each([1, 2, 15, 16, 17, 32, 33, 34, 65, 97, 128, 65536])(
  'prefix/ciphertext/tag boundaries work at chunk width %i',
  width => {
    const input = file(Buffer.from('a'.repeat(311)))
    const result = consume(input, width)
    expect(result.ciphertext).toEqual(Buffer.from('a'.repeat(311)))
    expect(result.end.tag).toEqual(new Uint8Array(16).fill(99))
    expect(result.end.fileBytes).toBe(input.length)
    expect(result.end.ciphertextBytes).toBe(311)
    expect(result.output.every(chunk => chunk.length <= width)).toBe(true)
    expect(result.header).toMatchObject({ iterations: 7, memoryKiB: 131072, parallelism: 1 })
  }
)
test.each([
  [1, 1],
  [8, 12],
  [255, 255]
])('valid non-default imported salt %i and nonce %i lengths remain accepted', (saltLength, nonceLength) => {
  const result = consume(file(undefined, saltLength, nonceLength), 13)
  expect(result.header?.salt).toHaveLength(saltLength)
  expect(result.header?.nonce).toHaveLength(nonceLength)
})
test.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 19, 20, 21, 25, 32])(
  'invalid fixed header byte %i refuses as soon as the fixed header closes',
  position => {
    const bytes = file()
    bytes[position] = position === 9 || position === 10 || position === 19 ? 0 : bytes[position] ^ 1
    const frame = new Brc39StreamFrame(policy)
    frame.accept(bytes.slice(0, 32))
    expect(() => frame.accept(bytes.slice(32, 33))).toThrow()
    expect(() => frame.accept(new Uint8Array())).toThrow(/closed/)
  }
)
test.each([11, 15])('zero encoded work at %i refuses before any derivation or ciphertext', position => {
  const bytes = file()
  bytes.fill(0, position, position + 4)
  expect(() => new Brc39StreamFrame(policy).accept(bytes.slice(0, 33))).toThrow(RangeError)
})
test.each(['maximumIterations', 'maximumMemoryKiB', 'maximumParallelism'] as const)(
  'explicit %s work policy refuses before salt/nonce allocation',
  name => {
    const bounded = { ...policy, [name]: 1 }
    if (name === 'maximumParallelism') bounded.maximumParallelism = 1
    const bytes = file()
    if (name === 'maximumParallelism') bytes[19] = 2
    expect(() => new Brc39StreamFrame(bounded).accept(bytes.slice(0, 33))).toThrow(SnapshotResourceLimitError)
  }
)
test('import retains valid weak historical parameters while new exports refuse weaker strength', () => {
  const bytes = file()
  new DataView(bytes.buffer).setUint32(11, 1)
  new DataView(bytes.buffer).setUint32(15, 64)
  expect(consume(bytes, 64).header).toMatchObject({ iterations: 1, memoryKiB: 64 })
  expect(() => encodeBrc39StreamPrefix({ ...BRC39_STREAM_DEFAULT_KDF, iterations: 1 }, salt, nonce, policy)).toThrow(
    /canonical/
  )
  expect(() => encodeBrc39StreamPrefix({ ...BRC39_STREAM_DEFAULT_KDF, memoryKiB: 64 }, salt, nonce, policy)).toThrow(
    /canonical/
  )
})
test.each([0, 1, 32, 33, 64, 96, 97, 112])(
  'truncated or empty ciphertext at length %i never produces a completed frame',
  length => {
    const bytes = file(Buffer.from([1]))
    const frame = new Brc39StreamFrame(policy)
    frame.accept(bytes.slice(0, length))
    expect(() => frame.finish()).toThrow(/Truncated/)
    expect(() => frame.finish()).toThrow(/closed/)
  }
)
test('exact file admission and detached policy/header/ciphertext/tag prevent caller mutation', () => {
  const bytes = file(Buffer.from('hello'))
  const options = { ...policy, maximumFileBytes: bytes.length }
  const frame = new Brc39StreamFrame(options)
  options.maximumFileBytes = 1
  const chunks = frame.accept(bytes)
  const header = frame.header()
  expect(header).toBeDefined()
  header!.salt.fill(0)
  bytes.fill(0)
  expect(frame.header()?.salt).toEqual(new Uint8Array(32).fill(42))
  expect(Buffer.concat(chunks)).toEqual(Buffer.from('hello'))
  expect(frame.finish().tag).toEqual(new Uint8Array(16).fill(99))
  expect(() => frame.header()).toThrow(/closed/)
})
test('oversized chunks/files and impossible prefixes refuse with terminal closure', () => {
  const bytes = file()
  const frame = new Brc39StreamFrame({ ...policy, maximumChunkBytes: 32 })
  expect(() => frame.accept(bytes.slice(0, 33))).toThrow(SnapshotResourceLimitError)
  expect(() => frame.finish()).toThrow(/closed/)
  const small = new Brc39StreamFrame({ ...policy, maximumFileBytes: bytes.length - 1 })
  expect(() => small.accept(bytes)).toThrow(SnapshotResourceLimitError)
  const impossible = new Brc39StreamFrame({ ...policy, maximumFileBytes: 113 })
  expect(() => impossible.accept(bytes.slice(0, 33))).toThrow(SnapshotResourceLimitError)
})
test.each([0, -1, 1.5, NaN, Infinity])('invalid explicit policy value %s is rejected', value => {
  expect(() => new Brc39StreamFrame({ ...policy, maximumFileBytes: value })).toThrow(RangeError)
})
test('bounded framing agrees with SDK and native AES-GCM for a 32-byte nonce without header AAD', () => {
  const key = new Uint8Array(32).fill(31)
  const plaintext = Buffer.from('synthetic canonical UTF8 \u00e9 \ud83c\udf3f')
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const prefix = encodeBrc39StreamPrefix(BRC39_STREAM_DEFAULT_KDF, salt, nonce, policy)
  const result = consume(new Uint8Array(Buffer.concat([prefix, ciphertext, tag])), 7)
  expect(Buffer.from(AESGCMDecrypt(result.ciphertext, nonce, result.end.tag, key)!)).toEqual(plaintext)
  const decoder = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  const provisional = decoder.update(result.ciphertext)
  decoder.setAuthTag(result.end.tag)
  expect(Buffer.concat([provisional, decoder.final()])).toEqual(plaintext)
  const unauthenticated = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  unauthenticated.update(result.ciphertext)
  const corrupt = result.end.tag.slice()
  corrupt[0] ^= 1
  unauthenticated.setAuthTag(corrupt)
  expect(() => unauthenticated.final()).toThrow()
})
