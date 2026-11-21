import { createHash } from 'node:crypto'
import { encodeBrc38StreamedRow, type Brc38StreamedRowPolicy, type Brc38StreamedBinary } from './Brc38StreamedRow'
import { createBrc38Stream, type Brc38StreamSource } from './Brc38Stream'
import { jsonStreamFixture } from './Brc38JsonStreamFixture'
import { parseBRC38Json, type BRC38Tables } from './index'

jest.setTimeout(30000)
const policy: Brc38StreamedRowPolicy = {
  maximumBinaryBytes: 1048576,
  maximumMetadataAllocationBytes: 65536,
  maximumRowBytes: 1500000,
  maximumChunkBytes: 64
}
const binaryReads = new WeakMap<Brc38StreamedBinary, Array<[number, number]>>()
function extents(source: Brc38StreamedBinary): Array<[number, number]> {
  const reads = binaryReads.get(source)
  if (reads === undefined) throw new Error('Independent binary observation missing')
  return reads
}
function binary(bytes: Uint8Array): Brc38StreamedBinary {
  const reads: Array<[number, number]> = []
  const result = {
    length: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    async read(offset: number, length: number) {
      reads.push([offset, length])
      return bytes.slice(offset, offset + length)
    }
  }
  binaryReads.set(result, reads)
  return result
}
async function text(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const parts = []
  for await (const bytes of chunks) {
    expect(bytes.byteLength).toBeLessThanOrEqual(64)
    parts.push(bytes)
  }
  // Whole-value materialization is confined to this small independent oracle.
  return Buffer.concat(parts).toString('utf8')
}

test.each([0, 1, 2, 3, 47, 48, 49, 1000])(
  'exact base64 spelling and bounded extents for %s binary bytes',
  async length => {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 256),
      source = binary(bytes)
    const row = await text(
      encodeBrc38StreamedRow(
        'transactions',
        {
          fields: { transactionId: 1, reference: 'original', updated_at: new Date('2026-01-01') },
          binaries: { rawTx: source }
        },
        policy
      )
    )
    expect(JSON.parse(row)).toEqual({
      transactionId: 1,
      reference: 'original',
      updated_at: '2026-01-01T00:00:00.000Z',
      rawTx: Buffer.from(bytes).toString('base64')
    })
    expect(extents(source).every(([, size]) => size <= 48)).toBe(true)
    expect(extents(source).reduce((total, [, size]) => total + size, 0)).toBe(length)
  }
)

test('wrong content digest or truncated extent rejects instead of producing a complete row', async () => {
  const source = binary(new Uint8Array([1, 2, 3]))
  source.sha256 = '00'.repeat(32)
  await expect(
    text(encodeBrc38StreamedRow('transactions', { fields: { transactionId: 1 }, binaries: { rawTx: source } }, policy))
  ).rejects.toThrow('content digest differs')
  source.sha256 = createHash('sha256')
    .update(new Uint8Array([1, 2, 3]))
    .digest('hex')
  source.read = async () => new Uint8Array(2)
  await expect(
    text(encodeBrc38StreamedRow('transactions', { fields: { transactionId: 1 }, binaries: { rawTx: source } }, policy))
  ).rejects.toThrow('binary extent')
})

test('metadata and binary policies reject before any source payload read', async () => {
  const source = binary(new Uint8Array(100)),
    read = jest.spyOn(source, 'read')
  await expect(
    text(
      encodeBrc38StreamedRow(
        'transactions',
        { fields: { transactionId: 1 }, binaries: { rawTx: source } },
        { ...policy, maximumBinaryBytes: 99 }
      )
    )
  ).rejects.toThrow()
  await expect(
    text(
      encodeBrc38StreamedRow(
        'transactions',
        { fields: { transactionId: 1 }, binaries: { rawTx: source } },
        { ...policy, maximumRowBytes: 100 }
      )
    )
  ).rejects.toThrow('encoded row')
  await expect(
    text(
      encodeBrc38StreamedRow(
        'transactions',
        { fields: { description: 'A'.repeat(1000) }, binaries: { rawTx: source } },
        { ...policy, maximumMetadataAllocationBytes: 100 }
      )
    )
  ).rejects.toThrow('allocation')
  expect(read).not.toHaveBeenCalled()
})

test('one awaited extent owns backpressure and abandonment schedules no additional read', async () => {
  const source = binary(new Uint8Array(200)),
    read = jest.spyOn(source, 'read')
  const iterator = encodeBrc38StreamedRow('transactions', { fields: {}, binaries: { rawTx: source } }, policy)
  while (read.mock.calls.length === 0) await iterator.next()
  expect(read).toHaveBeenCalledTimes(1)
  await iterator.return(undefined)
  expect(read).toHaveBeenCalledTimes(1)
})

test('all thirteen tables use the integrated streamed-row path and agree with the legacy parser', async () => {
  const data = jsonStreamFixture(),
    visited: Array<keyof BRC38Tables> = [],
    release = jest.fn(async () => undefined)
  const source: Brc38StreamSource = {
    sourceStorage: data.sourceStorage,
    user: data.user,
    async *rows() {
      yield await Promise.reject(new Error('The ordinary row path must not run for the negotiated streamed path'))
    },
    async *streamedRows(table) {
      visited.push(table)
      for (const row of data.tables[table]) {
        const fields = { ...row },
          binaries: Record<string, Brc38StreamedBinary> = {}
        for (const field of ['rawTx', 'inputBEEF', 'merklePath', 'lockingScript']) {
          if (typeof fields[field] !== 'string') continue
          binaries[field] = binary(new Uint8Array(Buffer.from(fields[field], 'base64')))
          delete fields[field]
        }
        yield { fields, binaries }
      }
    },
    async validateCompleted() {
      expect(visited).toHaveLength(13)
      parseBRC38Json(JSON.stringify(data))
    },
    release
  }
  const stream = await createBrc38Stream(source, {
    exportedAt: data.exportedAt,
    maximumArchiveBytes: 1048576,
    maximumRowBytes: 65536,
    maximumChunkBytes: 64,
    streamedRows: policy
  })
  expect(parseBRC38Json(await text(stream.chunks))).toEqual(data)
  await stream.validateCompleted()
  await stream.close()
  expect(release).toHaveBeenCalledTimes(1)
})

test.each([0, 1, 15, 16, 17, 1000])(
  'historical reclaim raw transaction retains number-array spelling for %s bytes',
  async length => {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 256),
      source = binary(bytes)
    const value = await text(
      encodeBrc38StreamedRow(
        'transactions',
        {
          fields: {},
          binaries: { noSendExpiryReclaimRawTx: source }
        },
        policy
      )
    )
    expect(value).toBe(JSON.stringify({ noSendExpiryReclaimRawTx: Array.from(bytes) }))
    expect(extents(source).every(([, size]) => size <= 16)).toBe(true)
  }
)
test('number-array byte accounting accepts small digits without charging the worst-case array representation', async () => {
  const source = binary(new Uint8Array(100))
  const value = await text(
    encodeBrc38StreamedRow(
      'transactions',
      {
        fields: {},
        binaries: { noSendExpiryReclaimRawTx: source }
      },
      { ...policy, maximumRowBytes: 250 }
    )
  )
  expect(value).toBe(JSON.stringify({ noSendExpiryReclaimRawTx: Array(100).fill(0) }))
})

test('an extra binary descriptor field rejects before a payload read', async () => {
  const source = binary(new Uint8Array([1, 2, 3])),
    read = jest.spyOn(source, 'read'),
    descriptor = { ...source, observation: [] }
  await expect(
    text(
      encodeBrc38StreamedRow(
        'transactions',
        {
          fields: {},
          binaries: { rawTx: descriptor }
        },
        policy
      )
    )
  ).rejects.toThrow('Invalid BRC-38 streamed row or binary extent')
  expect(read).not.toHaveBeenCalled()
})
