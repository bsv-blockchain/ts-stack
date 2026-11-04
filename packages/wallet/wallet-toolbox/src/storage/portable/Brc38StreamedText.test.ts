import { createHash } from 'node:crypto'
import { encodeBrc38StreamedText, type Brc38StreamedText } from './Brc38StreamedText'
import { encodeBrc38StreamedRow } from './Brc38StreamedRow'

// Authored only. Full-program qualification must include these cases; this
// module starts no native owner, worker, pool or actual archive transaction.
const policy = { maximumInputBytes: 1048576, maximumOutputBytes: 6291458, maximumChunkBytes: 64 }
function source(bytes: Uint8Array, encoding: Brc38StreamedText['encoding'] = 'utf8') {
  const read = jest.fn(async (offset: number, length: number): Promise<Uint8Array> =>
    bytes.slice(offset, offset + length)
  )
  return { encoding, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), read }
}
async function collect(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true }),
    parts: string[] = []
  for await (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(64)
    parts.push(decoder.decode(chunk, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join('')
}

test.each(['utf8', 'utf16le'] as const)(
  'preserves ordinary JSON Unicode, BOM and escaping across %s read boundaries',
  async encoding => {
    const text = '\ufeff' + 'x'.repeat(16380) + '😀\u0000\b\f\n\r\t"\\\u2028\u2029' + '𝄞'.repeat(10000),
      original = new Uint8Array(Buffer.from(text, encoding === 'utf8' ? 'utf8' : 'utf16le')),
      value = source(original, encoding)
    expect(await collect(encodeBrc38StreamedText(value, policy))).toBe(JSON.stringify(text))
    expect(value.read.mock.calls.every(([, length]) => length <= 16384)).toBe(true)
    expect(value.read.mock.calls.reduce((sum, [, length]) => sum + length, 0)).toBe(original.length)
    expect(original).toEqual(new Uint8Array(Buffer.from(text, encoding === 'utf8' ? 'utf8' : 'utf16le')))
  }
)

test('an empty string still checks its actual zero-length source', async () => {
  const value = source(new Uint8Array(0))
  expect(await collect(encodeBrc38StreamedText(value, policy))).toBe('""')
  expect(value.read).toHaveBeenCalledTimes(1)
  expect(value.read).toHaveBeenCalledWith(0, 0)
})

test.each([new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xed, 0xa0, 0x80]), new Uint8Array([0xf0, 0x9f, 0x98])])(
  'refuses malformed UTF8 rather than changing the archived value',
  async bytes => {
    await expect(collect(encodeBrc38StreamedText(source(bytes), policy))).rejects.toThrow()
  }
)

test('refuses lone UTF16 surrogates, incorrect digests, truncated reads and encoded budget excess', async () => {
  await expect(collect(encodeBrc38StreamedText(source(new Uint8Array([0, 0xd8]), 'utf16le'), policy))).rejects.toThrow()
  const value = source(new TextEncoder().encode('unchanged original'))
  await expect(collect(encodeBrc38StreamedText({ ...value, sha256: 'ff'.repeat(32) }, policy))).rejects.toThrow(
    'digest'
  )
  await expect(
    collect(encodeBrc38StreamedText({ ...value, read: async () => new Uint8Array(0) }, policy))
  ).rejects.toThrow('truncated')
  await expect(collect(encodeBrc38StreamedText(value, { ...policy, maximumOutputBytes: 4 }))).rejects.toThrow('budget')
})

test('captures descriptor data before the first awaited source loan', async () => {
  const value = source(new TextEncoder().encode('original')),
    read = value.read
  value.read = jest.fn(async (offset, length) => {
    value.length = 1000000
    value.sha256 = 'ff'.repeat(32)
    value.encoding = 'utf16le'
    return await read(offset, length)
  })
  expect(await collect(encodeBrc38StreamedText(value, policy))).toBe('"original"')
})

test('cancellation waits for the admitted read and discards its late plaintext', async () => {
  const controller = new AbortController(),
    bytes = new TextEncoder().encode('late'),
    value = source(bytes)
  let finish!: (bytes: Uint8Array) => void
  value.read = jest.fn(
    (_offset: number, _length: number) =>
      new Promise<Uint8Array>(yes => {
        finish = yes
      })
  )
  const iterator = encodeBrc38StreamedText(value, { ...policy, signal: controller.signal })
  expect(await iterator.next()).toEqual({ done: false, value: new Uint8Array([34]) })
  let settled = false
  const pending = iterator.next().finally(() => {
    settled = true
  })
  void pending.catch(() => undefined)
  controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(value.read).toHaveBeenCalledTimes(1)
  finish(bytes.slice())
  await expect(pending).rejects.toThrow()
})

test('raw TEXT keeps the portable row string format and cannot overlap inline metadata', async () => {
  const value = source(new TextEncoder().encode('original "description"')),
    rowPolicy = {
      maximumMetadataAllocationBytes: 65536,
      maximumBinaryBytes: 1048576,
      maximumTextBytes: 1048576,
      maximumRowBytes: 1048576,
      maximumChunkBytes: 64
    }
  expect(
    await collect(
      encodeBrc38StreamedRow(
        'transactions',
        {
          fields: { transactionId: 7 },
          binaries: {},
          texts: { description: value }
        },
        rowPolicy
      )
    )
  ).toBe(JSON.stringify({ description: 'original "description"', transactionId: 7 }))
  await expect(
    collect(
      encodeBrc38StreamedRow(
        'transactions',
        {
          fields: { description: 'inline' },
          binaries: {},
          texts: { description: value }
        },
        rowPolicy
      )
    )
  ).rejects.toThrow()
})
