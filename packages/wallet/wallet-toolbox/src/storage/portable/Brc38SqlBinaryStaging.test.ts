import { runInSeries } from '../../utility/runInSeries'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { jsonStreamFixture } from './Brc38JsonStreamFixture'

let parent = '',
  store: KnexBrc38StagingStore | undefined
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'brc38-binary-stage-'))
})
afterEach(async () => {
  await store?.discard(new Error('finite fixture cleanup'))
  await rm(parent, { recursive: true, force: true })
  store = undefined
})
async function create(maximumLogicalBytes = 1048576) {
  store = await KnexBrc38StagingStore.create(parent, {
    maximumRows: 100,
    maximumLogicalBytes,
    maximumPhysicalBytes: 4194304,
    maximumRowBytes: 65536,
    maximumRowAllocationBytes: 65536,
    expiresAt: Date.now() + 60000
  })
  return store
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('actual persisted chunks and whole digest are independently verified; prefix replay adds no logical charge', async () => {
  const target = await create(),
    data = Buffer.alloc(196625, 37)
  await target.beginBinaryField('transactions', 0, 'rawTx', 'base64', data.byteLength)
  for (let offset = 0; offset < data.byteLength; offset += 65536)
    await target.appendBinaryField('transactions', 0, 'rawTx', offset, data.subarray(offset, offset + 65536))
  await target.finishBinaryField('transactions', 0, {
    field: 'rawTx',
    encoding: 'base64',
    bytes: data.byteLength,
    sha256: digest(data)
  })
  const before = await target.knex('metadata').first('logicalBytes')
  await target.beginBinaryField('transactions', 0, 'rawTx', 'base64', data.byteLength)
  for (let offset = 0; offset < data.byteLength; offset += 65536)
    await target.appendBinaryField('transactions', 0, 'rawTx', offset, data.subarray(offset, offset + 65536))
  await target.finishBinaryField('transactions', 0, {
    field: 'rawTx',
    encoding: 'base64',
    bytes: data.byteLength,
    sha256: digest(data)
  })
  expect(await target.knex('metadata').first('logicalBytes')).toEqual(before)
  const recovered: Buffer[] = []
  for (let offset = 0; offset < data.byteLength;) {
    const actual = await target.readBinaryFieldChunk('transactions', 0, 'rawTx', offset)
    expect(actual).toBeDefined()
    expect(actual!.descriptor.sha256).toBe(digest(data))
    expect(actual!.bytes.byteLength).toBeLessThanOrEqual(65536)
    recovered.push(Buffer.from(actual!.bytes))
    offset += actual!.bytes.byteLength
    actual!.bytes.fill(3)
  }
  expect(Buffer.concat(recovered)).toEqual(data)
  expect(await target.readBinaryFieldChunk('transactions', 0, 'rawTx', data.byteLength)).toBeUndefined()
})

test('field cap and global logical quota reject atomically without leaving an uncharged native chunk', async () => {
  const target = await create(400)
  await target.beginBinaryField('transactions', 0, 'rawTx', 'base64', 2)
  await expect(target.appendBinaryField('transactions', 0, 'rawTx', 0, new Uint8Array(3))).rejects.toBeInstanceOf(
    SnapshotResourceLimitError
  )
  expect(await target.knex('private_binary_chunks').count({ count: '*' }).first()).toEqual({ count: 0 })
  const before = await target.knex('metadata').first('logicalBytes')
  // 256+5 field metadata +2 payload +128 chunk overhead fits once; another
  // field's reserved metadata does not fit the actual400-byte global budget.
  await target.appendBinaryField('transactions', 0, 'rawTx', 0, new Uint8Array([1, 2]))
  await expect(target.beginBinaryField('transactions', 0, 'inputBEEF', 'base64', 2)).rejects.toBeInstanceOf(
    SnapshotResourceLimitError
  )
  expect(await target.knex('private_binary_fields').count({ count: '*' }).first()).toEqual({ count: 1 })
  expect((await target.knex('metadata').first('logicalBytes')).logicalBytes).toBe(before.logicalBytes + 130)
})

test('metadata order, full digest, prefix bytes and fresh physical schema remain independent checks', async () => {
  const target = await create(),
    data = new Uint8Array([1, 2, 3])
  await expect(target.beginBinaryField('transactions', 1, 'rawTx', 'base64', 3)).rejects.toThrow('coordinate differs')
  await target.beginBinaryField('transactions', 0, 'rawTx', 'base64', 3)
  await target.appendBinaryField('transactions', 0, 'rawTx', 0, data)
  await expect(
    target.finishBinaryField('transactions', 0, {
      field: 'rawTx',
      encoding: 'base64',
      bytes: 3,
      sha256: '0'.repeat(64)
    })
  ).rejects.toThrow('coordinate differs')
  await expect(target.appendBinaryField('transactions', 0, 'rawTx', 0, new Uint8Array([3, 2, 1]))).rejects.toThrow(
    'coordinate differs'
  )
  await target.finishBinaryField('transactions', 0, {
    field: 'rawTx',
    encoding: 'base64',
    bytes: 3,
    sha256: digest(data)
  })
  await target.knex.raw('CREATE TRIGGER private_field_peer AFTER INSERT ON private_binary_chunks BEGIN SELECT 1; END')
  await expect(target.readBinaryFieldChunk('transactions', 0, 'rawTx', 0)).rejects.toThrow('coordinate differs')
})

test('native corruption is refused before becoming field-aware content; legacy seal cannot drop staged binary payloads', async () => {
  const target = await create(),
    data = new Uint8Array([1, 2, 3])
  await target.beginBinaryField('transactions', 0, 'rawTx', 'base64', 3)
  await target.appendBinaryField('transactions', 0, 'rawTx', 0, data)
  await expect(target.knex('private_binary_chunks').update({ payload: Buffer.from([3, 2, 1]) })).rejects.toThrow()
  // Simulated out-of-band schema/content corruption cannot retain admission.
  await target.knex.raw('DROP TRIGGER private_binary_chunks_prefix_update')
  await target.knex('private_binary_chunks').update({ payload: Buffer.from([3, 2, 1]) })
  await expect(
    target.finishBinaryField('transactions', 0, { field: 'rawTx', encoding: 'base64', bytes: 3, sha256: digest(data) })
  ).rejects.toThrow('immutable prefix definitions differ')
  const fixture = jsonStreamFixture(),
    header = { ...fixture, tables: { ...fixture.tables } }
  for (const table of Object.keys(header.tables) as Array<keyof typeof header.tables>) header.tables[table] = []
  const counts = Object.fromEntries(Object.keys(fixture.tables).map(name => [name, 0])) as Record<
    keyof typeof fixture.tables,
    number
  >
  await expect(target.seal(header, counts)).rejects.toThrow('immutable prefix definitions differ')
})

test('the real bounded JSON parser binds private fields to the same physical reservation without activating incomplete semantics', async () => {
  const target = await create(),
    data = jsonStreamFixture()
  data.tables.transactions[0].rawTx = Buffer.alloc(131073, 41).toString('base64')
  const { readBrc38JsonStream } = await import('./Brc38JsonStream')
  const { brc38SqlStreamedFieldSink } = await import('./Brc38SqlStreamedFieldSink')
  const policy = { maximumBinaryBytes: 262144, maximumChunkBytes: 65536 }
  const staged: string[] = []
  const fields = brc38SqlStreamedFieldSink(target, policy, async (table, index, row) => {
    staged.push(table)
    // This fixture deliberately stores private metadata only. The actual seal
    // must refuse, so no test can accidentally bless omitted binary payloads.
    await target.appendStreamed({ table, index, row: row.fields, uniqueKeys: [], memberships: [] }, row.binaries)
  })
  async function* input() {
    const bytes = Buffer.from(JSON.stringify(data))
    for (let offset = 0; offset < bytes.byteLength; offset += 65536)
      yield Uint8Array.from(bytes.subarray(offset, offset + 65536))
  }
  let verified = false
  await expect(
    readBrc38JsonStream(
      input(),
      {
        streamedFields: fields,
        provisionalRow: async () => {
          throw new Error('Unexpected materialized row')
        },
        validateCompleted: async (header, counts) => {
          const first = await target.readBinaryFieldChunk('transactions', 0, 'rawTx', 0)
          expect(first!.descriptor.bytes).toBe(131073)
          expect(first!.descriptor.sha256).toBe(digest(Buffer.alloc(131073, 41)))
          let offset = 0
          const whole = createHash('sha256')
          function* remainingChunks() {
            for (let index = 0; offset < 131073 && index < 131073; index++) yield offset
          }
          await runInSeries(remainingChunks(), async selectedOffset => {
            const chunk = await target.readBinaryFieldChunk('transactions', 0, 'rawTx', selectedOffset)
            expect(chunk).toBeDefined()
            expect(chunk!.offset).toBe(selectedOffset)
            expect(chunk!.bytes.byteLength).toBeGreaterThan(0)
            expect(chunk!.bytes.byteLength).toBeLessThanOrEqual(65536)
            expect(chunk!.bytes).toEqual(Uint8Array.from(Buffer.alloc(chunk!.bytes.byteLength, 41)))
            whole.update(chunk!.bytes)
            offset += chunk!.bytes.byteLength
          })
          expect(offset).toBe(131073)
          expect(whole.digest('hex')).toBe(digest(Buffer.alloc(131073, 41)))
          expect(await target.readBinaryFieldChunk('transactions', 0, 'rawTx', offset)).toBeUndefined()
          verified = true
          await target.seal(header, counts)
        },
        discard: async cause => await target.discard(cause)
      },
      { maximumArchiveBytes: 1048576, maximumRowAllocationBytes: 32768, streamedFields: policy }
    )
  ).rejects.toThrow('Private source field family, immutable generation or current counts differs')
  expect(staged).toHaveLength(13)
  expect(verified).toBe(true)
})
