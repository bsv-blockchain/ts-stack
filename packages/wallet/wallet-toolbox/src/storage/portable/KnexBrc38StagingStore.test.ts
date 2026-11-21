import createKnex from 'knex'
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnexBrc38StagingStore, type KnexBrc38StagingLimits } from './KnexBrc38StagingStore'
import { Brc38SemanticStage, brc38StageTables } from './Brc38SemanticStage'
import { semanticStageFixture, options, source } from './Brc38SemanticStageFixture'
import { readBrc38JsonStream } from './Brc38JsonStream'
import { importJournalFixture } from './Brc38ImportJournalFixture'

let parent = '',
  stores: KnexBrc38StagingStore[] = []
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'brc38-staging-test-'))
  stores = []
})
afterEach(async () => {
  for (const store of stores) await store.discard(new Error('test cleanup'))
  await rm(parent, { recursive: true, force: true })
})
async function makeStore(override: Partial<KnexBrc38StagingLimits> = {}) {
  const store = await KnexBrc38StagingStore.create(parent, {
    maximumRows: 10000,
    maximumLogicalBytes: 1048576,
    maximumPhysicalBytes: 4194304,
    maximumRowBytes: 65536,
    maximumRowAllocationBytes: 65536,
    expiresAt: Date.now() + 60000,
    ...override
  })
  stores.push(store)
  return store
}
async function inspect<T>(
  store: KnexBrc38StagingStore,
  work: (db: ReturnType<typeof createKnex>) => Promise<T>
): Promise<T> {
  const db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: join(store.directory, 'stage.sqlite') },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    return await work(db)
  } finally {
    await db.destroy()
  }
}
test('a real legacy SQLite stage cannot become an authenticated native structured projection source', async () => {
  const store = await makeStore(),
    work = jest.fn(async () => undefined),
    before = await readdir(parent)
  await inspect(
    store,
    async db =>
      await db.transaction(async trx => {
        await expect(
          store.withPrivateStructuredFieldSource(
            trx,
            'provenTxReqs',
            0,
            'history',
            {
              privateIndexParent: parent,
              maximumTemporaryIndexBytes: 1048576,
              maximumIndexMembers: 100,
              maximumStructuredBytes: 1000,
              maximumCanonicalBytes: 1000
            },
            work
          )
        ).rejects.toThrow('Private native read transaction requires its actual source owner')
      })
  )
  expect(work).not.toHaveBeenCalled()
  expect(await readdir(parent)).toEqual(before)
})
test('a real legacy transaction cannot borrow the private native read assertion or change source bytes', async () => {
  const store = await makeStore(),
    before = await inspect(store, db => db('metadata').first()),
    beforeFiles = await readdir(parent)
  await inspect(
    store,
    async db =>
      await db.transaction(async trx => {
        expect(() => store.assertPrivateNativeReadTransaction(trx)).toThrow('actual source owner')
      })
  )
  expect(await inspect(store, db => db('metadata').first())).toEqual(before)
  expect(await readdir(parent)).toEqual(beforeFiles)
})
test('structured publication cannot copy a genuine legacy stage or create a target', async () => {
  const store = await makeStore(),
    journal = await importJournalFixture(),
    before = await inspect(store, db => db('metadata').first()),
    beforeFiles = await readdir(parent),
    expiresAt = store.limits.expiresAt
  try {
    await expect(
      store.copyCompletedStructuredNativeRestore(join(parent, 'forbidden.sqlite'), journal.admission, 1048576, {
        sourcePolicy: {
          privateIndexParent: parent,
          maximumTemporaryIndexBytes: 1048576,
          maximumIndexMembers: 100,
          maximumStructuredBytes: 1000,
          maximumCanonicalBytes: 1000
        },
        projectionPolicy: {
          privateParent: parent,
          maximumTemporaryFileBytes: 2097152,
          maximumMembers: 100,
          maximumOutputBytes: 1000,
          maximumScalarBytes: 1000,
          expiresAt
        },
        maximumCombinedTemporaryBytes: 3145728
      })
    ).rejects.toThrow('original private native owner')
    expect(await inspect(store, db => db('metadata').first())).toEqual(before)
    expect(await readdir(parent)).toEqual(beforeFiles)
  } finally {
    await journal.close()
  }
})
test('structured semantic replay and sealing refuse a real legacy owner without changing its source', async () => {
  const store = await makeStore(),
    data = semanticStageFixture(),
    counts = Object.fromEntries(brc38StageTables.map(table => [table, 0])) as Record<
      (typeof brc38StageTables)[number],
      number
    >,
    policy = {
      privateIndexParent: parent,
      maximumTemporaryIndexBytes: 1048576,
      maximumIndexMembers: 100,
      maximumStructuredBytes: 1000,
      maximumCanonicalBytes: 1000
    },
    beforeFiles = await readdir(parent),
    beforeMetadata = await inspect(store, db => db('metadata').first())
  await expect(store.verifyPrivateStructuredSemantics(data, counts, policy)).rejects.toThrow(
    'actual private native source'
  )
  await expect(store.sealStructuredStreamed(data, counts, policy)).rejects.toThrow('actual private native source')
  expect(await inspect(store, db => db('metadata').first())).toEqual(beforeMetadata)
  expect(await readdir(parent)).toEqual(beforeFiles)
})
test('structured authenticated reader and destination facades cannot promote a real legacy SQLite owner', async () => {
  const store = await makeStore(),
    callback = jest.fn(async () => undefined),
    before = await inspect(store, db => db('metadata').first())
  await expect(store.withAuthenticatedStructuredImportView(callback)).rejects.toThrow()
  await expect(store.withAuthenticatedStructuredImportRead(callback)).rejects.toThrow()
  await expect(store.withAuthenticatedPrivateStructuredDestination(callback)).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
  expect(await inspect(store, db => db('metadata').first())).toEqual(before)
})
test('real private SQLite stores all thirteen tables and faithful sealed provenance', async () => {
  const store = await makeStore(),
    data = semanticStageFixture()
  await readBrc38JsonStream(source(data), new Brc38SemanticStage(store, options), {
    maximumArchiveBytes: 1048576,
    maximumRowAllocationBytes: 65536
  })
  for (const table of brc38StageTables) {
    expect(await store.count(table)).toBe(1)
    expect(await store.row(table, 0)).toEqual(data.tables[table][0])
  }
  const meta = await inspect(store, db => db('metadata').first())
  expect(meta.state).toBe('sealed')
  expect(meta.rows).toBe(13)
  const header = JSON.parse(meta.header)
  expect(header.sourceStorage).toEqual(data.sourceStorage)
  expect(header.user).toEqual(data.user)
  for (const table of brc38StageTables) expect(header.tables[table]).toEqual([])
  expect((await stat(store.directory)).mode & 0o777).toBe(0o700)
  expect((await stat(join(store.directory, 'stage.sqlite'))).mode & 0o777).toBe(0o600)
  expect(await inspect(store, db => db.raw('PRAGMA journal_mode'))).toEqual([{ journal_mode: 'delete' }])
  expect(await inspect(store, db => db('sqlite_master').where({ name: 'users' }).first())).toBeUndefined()
  await expect(
    store.append({
      table: 'outputs',
      index: 1,
      row: data.tables.outputs[0],
      uniqueKeys: [],
      memberships: []
    })
  ).rejects.toThrow('sealed')
})
test('duplicate natural key rolls back row, every key and all counters atomically', async () => {
  const store = await makeStore(),
    stage = new Brc38SemanticStage(store, options),
    row = semanticStageFixture().tables.outputBaskets[0]
  await stage.provisionalRow('outputBaskets', 0, row)
  const before = await inspect(store, db => db('metadata').first())
  await expect(stage.provisionalRow('outputBaskets', 1, { ...row, basketId: 99 })).rejects.toThrow('UNIQUE')
  expect(await store.count('outputBaskets')).toBe(1)
  expect(await store.row('outputBaskets', 1)).toBeUndefined()
  expect(await store.has('outputBaskets', '[99]')).toBe(false)
  expect(await inspect(store, db => db('metadata').first())).toEqual(before)
})
test('logical quota refuses before writes and does not advance persisted counts', async () => {
  const store = await makeStore({ maximumLogicalBytes: 1 }),
    stage = new Brc38SemanticStage(store, options)
  await expect(stage.provisionalRow('outputs', 0, semanticStageFixture().tables.outputs[0])).rejects.toThrow(
    'logical quota'
  )
  expect(await store.count('outputs')).toBe(0)
  expect(await inspect(store, db => db('rows').first())).toBeUndefined()
})
test('serialized row and detached allocation limits refuse before SQL writes', async () => {
  const store = await makeStore({ maximumRowBytes: 1 }),
    stage = new Brc38SemanticStage(store, options)
  await expect(stage.provisionalRow('outputs', 0, semanticStageFixture().tables.outputs[0])).rejects.toThrow(
    'serialized byte policy'
  )
  expect(await store.count('outputs')).toBe(0)
  const bounded = await makeStore({ maximumRowAllocationBytes: 1 })
  await expect(
    new Brc38SemanticStage(bounded, options).provisionalRow('outputs', 0, semanticStageFixture().tables.outputs[0])
  ).rejects.toThrow('allocation budget')
  expect(await bounded.count('outputs')).toBe(0)
})
test('hard DB page ceiling reserves rollback journal capacity before a larger import', async () => {
  const store = await makeStore({ maximumPhysicalBytes: 1048576 })
  const pages = await store.knex.raw('PRAGMA max_page_count')
  expect(pages[0].max_page_count * 4096 * 3 + 65536).toBeLessThanOrEqual(1048576)
  let footprint = 0
  for (const name of await readdir(store.directory)) footprint += (await stat(join(store.directory, name))).size
  expect(footprint).toBeLessThan(1048576)
})
test('failed semantic completion waits for physical cleanup and removes the owned directory', async () => {
  const store = await makeStore(),
    data = semanticStageFixture()
  data.tables.outputTagMaps[0].outputId = 999
  await expect(
    readBrc38JsonStream(source(data), new Brc38SemanticStage(store, options), {
      maximumArchiveBytes: 1048576,
      maximumRowAllocationBytes: 65536
    })
  ).rejects.toThrow('does not reference')
  await expect(stat(store.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(store.count('outputs')).rejects.toThrow('unavailable')
  await store.discard(new Error('again'))
})
test('missing coordinates return undefined while forged persisted byte bounds refuse payload loading', async () => {
  const store = await makeStore(),
    stage = new Brc38SemanticStage(store, options)
  expect(await store.row('outputs', 0)).toBeUndefined()
  await stage.provisionalRow('outputs', 0, semanticStageFixture().tables.outputs[0])
  await inspect(store, db => db('rows').where({ tableName: 'outputs', position: 0 }).update({ bytes: 1000000 }))
  await expect(store.row('outputs', 0)).rejects.toThrow('byte bound')
})
test('actual SQLite physical limit refuses a larger stage and rolls back the failing append', async () => {
  const store = await makeStore({ maximumPhysicalBytes: 1048576 }),
    stage = new Brc38SemanticStage(store, options),
    row = semanticStageFixture().tables.outputs[0]
  let refused = false,
    accepted = 0
  for (let index = 0; index < 1000; index++) {
    try {
      await stage.provisionalRow('outputs', index, {
        ...row,
        outputId: index + 16,
        vout: index,
        customInstructions: 'synthetic large row'.repeat(512)
      })
      accepted++
    } catch (cause) {
      expect(cause).toBeInstanceOf(AggregateError)
      const first = (cause as AggregateError).errors[0] as Error & { code: string },
        rollback = (cause as AggregateError).errors[1] as Error
      expect(first.code).toBe('SQLITE_FULL')
      expect(String(first)).toMatch(/database or disk is full/)
      expect(String(rollback)).toMatch(/no transaction is active/)
      refused = true
      break
    }
  }
  expect(refused).toBe(true)
  expect(accepted).toBeGreaterThan(1)
  expect(accepted).toBeLessThan(1000)
  expect(await store.count('outputs')).toBe(accepted)
  expect(await store.row('outputs', accepted)).toBeUndefined()
  expect((await inspect(store, db => db('metadata').first())).rows).toBe(accepted)
  let footprint = 0
  for (const name of await readdir(store.directory)) {
    const file = await stat(join(store.directory, name))
    footprint += Math.max(file.size, file.blocks * 512)
  }
  expect(footprint).toBeLessThanOrEqual(1048576)
})
test.each([
  { maximumRows: 0 },
  { maximumRows: 1.5 },
  { maximumLogicalBytes: 0 },
  { maximumPhysicalBytes: 1048575 },
  { maximumRowBytes: 0 },
  { maximumRowAllocationBytes: 16777217 },
  { expiresAt: 0 }
])('invalid %j limits refuse before creating owned files', async override => {
  await expect(makeStore(override)).rejects.toThrow('limit')
  expect(await readdir(parent)).toEqual([])
})
test('fixed expiry rejects subsequent reads but physical cleanup still completes', async () => {
  const deadline = Date.now() + 60000,
    store = await makeStore({ expiresAt: deadline }),
    clock = jest.spyOn(Date, 'now').mockReturnValue(deadline)
  try {
    await expect(store.count('outputs')).rejects.toThrow('expired')
    await store.discard(new Error('lease expiry'))
    await expect(stat(store.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    clock.mockRestore()
  }
})
test('expiry during creation tears down the real SQL pool and owned directory', async () => {
  const started = Date.now()
  let reads = 0
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => (reads++ < 2 ? started : started + 60000))
  try {
    await expect(makeStore({ expiresAt: started + 30000 })).rejects.toThrow('expired')
    expect(await readdir(parent)).toEqual([])
  } finally {
    clock.mockRestore()
  }
})
test('concurrent I/O and disposal refuse until a real owned append settles', async () => {
  const store = await makeStore(),
    stage = new Brc38SemanticStage(store, options)
  const append = stage.provisionalRow('outputs', 0, semanticStageFixture().tables.outputs[0])
  await expect(store.count('outputs')).rejects.toThrow('already owned')
  await expect(store.discard(new Error('cancel'))).rejects.toThrow('Wait for owned')
  await append
  expect(await store.count('outputs')).toBe(1)
  await store.discard(new Error('cancel'))
  await expect(stat(store.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
test('failed driver teardown retains the private directory until successful retry', async () => {
  const store = await makeStore(),
    original = store.knex.client.destroy.bind(store.knex.client),
    cause = new Error('owned driver teardown failed')
  const destroy = jest.spyOn(store.knex.client, 'destroy').mockRejectedValueOnce(cause).mockImplementation(original)
  await expect(store.discard(new Error('cancel'))).rejects.toBe(cause)
  expect((await stat(store.directory)).isDirectory()).toBe(true)
  await store.discard(new Error('cancel'))
  expect(destroy).toHaveBeenCalledTimes(2)
  await expect(stat(store.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
test('oversized indexed keys/counts refuse before any persisted row or counter', async () => {
  const store = await makeStore(),
    row = semanticStageFixture().tables.outputs[0]
  await expect(
    store.append({
      table: 'outputs',
      index: 0,
      row,
      uniqueKeys: [{ namespace: 'outputs', key: 'x'.repeat(65537) }],
      memberships: []
    })
  ).rejects.toThrow('indexed key')
  await expect(
    store.append({
      table: 'outputs',
      index: 0,
      row,
      uniqueKeys: [
        { namespace: 'one', key: '1' },
        { namespace: 'two', key: '2' },
        { namespace: 'three', key: '3' }
      ],
      memberships: []
    })
  ).rejects.toThrow('key count')
  expect(await store.count('outputs')).toBe(0)
})
test('missing durable metadata and payload length corruption refuse safely', async () => {
  const store = await makeStore(),
    stage = new Brc38SemanticStage(store, options)
  await stage.provisionalRow('outputs', 0, semanticStageFixture().tables.outputs[0])
  await inspect(store, db => db('rows').where({ tableName: 'outputs', position: 0 }).update({ payload: '{}' }))
  await expect(store.row('outputs', 0)).rejects.toThrow('length is inconsistent')
  await inspect(store, db => db('metadata').delete())
  await expect(
    stage.provisionalRow('outputs', 1, {
      ...semanticStageFixture().tables.outputs[0],
      outputId: 99,
      vout: 1
    })
  ).rejects.toThrow('metadata is missing')
  expect(await store.count('outputs')).toBe(1)
})
