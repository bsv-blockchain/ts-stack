import { createDecipheriv } from 'node:crypto'
import fc from 'fast-check'
import { createBrc38Stream, type Brc38StreamSource, type Brc38StreamOptions } from './Brc38Stream'
import { Brc39StreamFrame } from './Brc39Frame'
import { encryptBRC39, parseBRC38Json, type BRC38WalletData, type BRC38Tables } from './index'
import { encryptBrc39StreamToQuarantine } from './Brc39StreamNode'
import {
  registerArgon2idBackend,
  unregisterArgon2idBackend,
  type AsyncArgon2idBackend
} from '../../utility/Argon2idBackend'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

const iso = '2026-10-03T00:00:00.000Z'
const options: Brc38StreamOptions = {
  exportedAt: iso,
  maximumArchiveBytes: 1048576,
  maximumRowBytes: 65536,
  maximumChunkBytes: 64
}
let backend: AsyncArgon2idBackend | undefined
afterEach(() => {
  if (backend !== undefined) unregisterArgon2idBackend(backend)
  backend = undefined
})
function document(): BRC38WalletData {
  const times = { created_at: iso, updated_at: iso }
  return {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt: iso,
    sourceStorage: { ...times, storageIdentityKey: 'original-source', storageName: 'original source', chain: 'test' },
    user: { ...times, userId: 7, identityKey: 'original-identity', activeStorage: 'original-source' },
    tables: {
      provenTxs: [{ ...times, provenTxId: 11, txid: 'a'.repeat(64), rawTx: 'AQI=', merklePath: 'AwQ=' }],
      provenTxReqs: [{ ...times, provenTxReqId: 12, txid: 'a'.repeat(64), provenTxId: 11 }],
      outputBaskets: [{ ...times, basketId: 13, userId: 7, name: 'default', isDeleted: false }],
      transactions: [{ ...times, transactionId: 14, userId: 7, txid: 'a'.repeat(64), provenTxId: 11 }],
      commissions: [{ ...times, commissionId: 15, userId: 7, transactionId: 14 }],
      outputs: [
        { ...times, outputId: 16, userId: 7, transactionId: 14, basketId: 13, spentBy: 14, lockingScript: 'AQI=' }
      ],
      outputTags: [{ ...times, outputTagId: 17, userId: 7, tag: 'tag \u{1f642}', isDeleted: true }],
      outputTagMaps: [{ ...times, outputId: 16, outputTagId: 17 }],
      txLabels: [{ ...times, txLabelId: 18, userId: 7, label: 'label', isDeleted: false }],
      txLabelMaps: [{ ...times, transactionId: 14, txLabelId: 18 }],
      certificates: [{ ...times, certificateId: 19, userId: 7 }],
      certificateFields: [{ ...times, certificateId: 19, userId: 7, fieldName: 'name', fieldValue: 'value' }],
      syncStates: [{ ...times, syncStateId: 20, userId: 7, storageIdentityKey: 'original-source', syncMap: {} }]
    }
  }
}
function source(
  data = document()
): Brc38StreamSource & { visits: Array<keyof BRC38Tables>; released: number; validated: number } {
  const current = {
    sourceStorage: data.sourceStorage,
    user: data.user,
    visits: [] as Array<keyof BRC38Tables>,
    released: 0,
    validated: 0,
    async *rows(table: keyof BRC38Tables) {
      current.visits.push(table)
      for (const row of data.tables[table]) yield row
    },
    async validateCompleted() {
      expect(parseBRC38Json(JSON.stringify(data))).toEqual(data)
      current.validated++
    },
    async release() {
      current.released++
    }
  }
  return current
}
async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const bytes of chunks) {
    expect(bytes.length).toBeLessThanOrEqual(64)
    parts.push(bytes)
  }
  // Complete materialization exists only in the bounded synthetic test oracle.
  return Buffer.concat(parts)
}
function fixedBackend(): Uint8Array {
  const key = new Uint8Array(32).fill(17)
  backend = { preload: async () => {}, isReady: () => true, deriveKey: async () => key.slice() }
  registerArgon2idBackend(backend)
  return key
}

test('all thirteen tables match exact plaintext bytes from the independent legacy encrypted exporter', async () => {
  const key = fixedBackend()
  const data = document()
  const owner = source(data)
  const stream = await createBrc38Stream(owner, options)
  const bytes = await collect(stream.chunks)
  expect(parseBRC38Json(bytes.toString())).toEqual(data)
  await stream.validateCompleted()
  await stream.close()
  expect(owner.released).toBe(1)
  expect(owner.validated).toBe(1)
  expect(owner.visits).toEqual([
    'certificateFields',
    'certificates',
    'commissions',
    'outputBaskets',
    'outputTagMaps',
    'outputTags',
    'outputs',
    'provenTxReqs',
    'provenTxs',
    'syncStates',
    'transactions',
    'txLabelMaps',
    'txLabels'
  ])
  const encrypted = await encryptBRC39(data, 'password')
  const frame = new Brc39StreamFrame({
    maximumFileBytes: 1048576,
    maximumChunkBytes: 65536,
    maximumIterations: 7,
    maximumMemoryKiB: 131072,
    maximumParallelism: 1
  })
  const ciphertext = frame.accept(new Uint8Array(encrypted))
  const header = frame.header()
  if (header === undefined) throw new Error('legacy envelope has no header')
  const tag = frame.finish().tag
  const cipher = createDecipheriv('aes-256-gcm', key, header.nonce, { authTagLength: 16 })
  cipher.setAuthTag(tag)
  const plaintext = Buffer.concat([...ciphertext.map(chunk => cipher.update(chunk)), cipher.final()])
  expect(bytes).toEqual(plaintext)
})

test('source metadata detaches before the first asynchronous boundary and each row before output', async () => {
  const data = document()
  const original = structuredClone(data)
  data.tables.outputTags[0].tag = 'A'.repeat(1024)
  original.tables.outputTags[0].tag = 'A'.repeat(1024)
  const owner = source(data)
  // This test's independently validated fixture is the original source view.
  owner.validateCompleted = async () => {
    expect(parseBRC38Json(JSON.stringify(original))).toEqual(original)
  }
  const pending = createBrc38Stream(owner, options)
  data.sourceStorage.storageName = 'later alias'
  data.user.identityKey = 'later alias'
  const stream = await pending
  const parts: Uint8Array[] = []
  let changed = false
  for await (const bytes of stream.chunks) {
    parts.push(bytes)
    if (!changed && Buffer.concat(parts).includes(Buffer.from('AAAA'))) {
      changed = true
      data.tables.outputTags[0].updated_at = '2026-10-04T00:00:00.000Z'
    }
  }
  expect(changed).toBe(true)
  expect(parseBRC38Json(Buffer.concat(parts).toString())).toEqual(original)
  await stream.validateCompleted()
  expect(owner.released).toBe(1)
})

test('no rows are prefetched while provisional header output is held', async () => {
  const owner = source()
  const stream = await createBrc38Stream(owner, options)
  await expect(stream.validateCompleted()).rejects.toThrow('did not complete')
  const first = await stream.chunks[Symbol.asyncIterator]().next()
  expect(first.done).toBe(false)
  expect(owner.visits).toEqual([])
  await stream.close()
  await stream.close()
  expect(owner.released).toBe(1)
  expect(owner.validated).toBe(0)
  await expect(stream.validateCompleted()).rejects.toThrow('did not complete')
})

test('an unused source can close without beginning row iteration', async () => {
  const owner = source()
  const stream = await createBrc38Stream(owner, options)
  await stream.close()
  expect(owner.released).toBe(1)
  expect(owner.visits).toEqual([])
  await expect(stream.validateCompleted()).rejects.toThrow('did not complete')
})

test.each(['maximumArchiveBytes', 'maximumRowBytes', 'maximumMetadataBytes'] as const)(
  'invalid %s releases the owned source before refusal',
  async name => {
    const owner = source()
    await expect(createBrc38Stream(owner, { ...options, [name]: 0 })).rejects.toThrow('must be an integer')
    expect(owner.released).toBe(1)
    expect(owner.visits).toEqual([])
  }
)

test('archive and row limits refuse partial output and release the source', async () => {
  const archive = source()
  const small = await createBrc38Stream(archive, { ...options, maximumArchiveBytes: 100 })
  await expect(collect(small.chunks)).rejects.toThrow('archive exceeds')
  await small.close()
  expect(archive.released).toBe(1)
  await expect(small.validateCompleted()).rejects.toThrow('did not complete')
  const rows = source()
  const bounded = await createBrc38Stream(rows, { ...options, maximumRowBytes: 1 })
  await expect(collect(bounded.chunks)).rejects.toThrow('allocation budget')
  await bounded.close()
  expect(rows.released).toBe(1)
})

test('metadata policy and malformed metadata refuse before row access', async () => {
  const bounded = source()
  await expect(createBrc38Stream(bounded, { ...options, maximumMetadataBytes: 1 })).rejects.toThrow('allocation budget')
  expect(bounded.released).toBe(1)
  const invalid = source()
  await expect(createBrc38Stream(invalid, { ...options, exportedAt: 'not a date' })).rejects.toThrow('timestamp')
  expect(invalid.released).toBe(1)
  expect(invalid.visits).toEqual([])
})

test('source processing and release failures retain both exact causes', async () => {
  const owner = source()
  const original = new Error('synthetic source read failure')
  const cleanup = new Error('synthetic source release failure')
  owner.rows = () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(original) }) })
  owner.release = async () => {
    throw cleanup
  }
  const stream = await createBrc38Stream(owner, options)
  await expect(collect(stream.chunks)).rejects.toMatchObject({ cause: original, errors: [original, cleanup] })
  await expect(stream.close()).rejects.toBe(cleanup)
  await expect(stream.validateCompleted()).rejects.toThrow('did not complete')
})

test('semantic completion failure prevents the encrypted tag and discards private output', async () => {
  fixedBackend()
  const owner = source()
  const original = new Error('synthetic source closure failure')
  owner.validateCompleted = async () => {
    throw original
  }
  const stream = await createBrc38Stream(owner, options)
  const output = {
    parts: [] as Uint8Array[],
    discarded: 0,
    async appendUntrusted(bytes: Uint8Array) {
      output.parts.push(bytes.slice())
    },
    async discard() {
      output.parts = []
      output.discarded++
    }
  }
  await expect(
    encryptBrc39StreamToQuarantine(stream, 'password', output, {
      policy: {
        maximumFileBytes: 1048576,
        maximumChunkBytes: 64,
        maximumIterations: 7,
        maximumMemoryKiB: 131072,
        maximumParallelism: 1
      },
      maximumPasswordBytes: 1024
    })
  ).rejects.toBe(original)
  expect(output.parts).toEqual([])
  expect(output.discarded).toBe(1)
  expect(owner.released).toBe(1)
})

test('cancellation releases the source and retains the exact reason', async () => {
  const owner = source()
  const controller = new AbortController()
  const original = new Error('operator cancellation')
  const stream = await createBrc38Stream(owner, { ...options, signal: controller.signal })
  controller.abort(original)
  await expect(collect(stream.chunks)).rejects.toBe(original)
  await stream.close()
  expect(owner.released).toBe(1)
})

test('generated standard rows retain source IDs, tombstones, bytes and complete tables', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.string({ maxLength: 40 }), { maxLength: 30 }), async names => {
      const data = document()
      data.tables.outputTags = names.map((tag, index) => ({
        created_at: iso,
        updated_at: iso,
        userId: 7,
        outputTagId: index + 1,
        tag,
        isDeleted: index % 2 === 0
      }))
      data.tables.outputTagMaps = []
      const owner = source(data)
      const stream = await createBrc38Stream(owner, options)
      try {
        const bytes = await collect(stream.chunks)
        expect(parseBRC38Json(bytes.toString())).toEqual(data)
        await stream.validateCompleted()
      } finally {
        await stream.close()
      }
      expect(owner.visits).toHaveLength(13)
      expect(owner.validated).toBe(1)
      expect(owner.released).toBe(1)
    }),
    {
      numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? 300)),
      seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
      path: process.env.FAST_CHECK_PATH ?? '',
      endOnFailure: true,
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
}, 180000)
