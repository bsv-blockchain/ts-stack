import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { PrivateKey, OutputProtocolError } from '@bsv/sdk'
import { MongoOverlayStorage } from '@bsv/overlay/storage/mongo/MongoOverlayStorage'
import { bootstrapMongoOverlay } from '@bsv/overlay/storage/mongo/MongoSchema'
import { SQLiteJournal } from '@bsv/output-knowledge/sqlite'
import { SQLiteOperationStateStore } from '@bsv/output-knowledge/operations/sqlite'
import { collectionOutputIndexKey } from '@bsv/output-knowledge/lookup'
import { createReferenceClient } from '../src/referenceClient.js'
import { startReferenceServer } from '../src/referenceServer.js'
import { createReferenceProvider } from '../src/referenceProvider.js'
import {
  createReferenceAdmissionProducer,
  createReferenceEngine,
  REFERENCE_TOPIC
} from '../src/referenceAdmissionProducer.js'
import { openReferenceMongo } from '../src/referenceMongo.js'
import { fixtureChain, referenceEvidence } from '../src/fixtureChain.js'
import {
  createMongoReplicaFixture,
  type MongoReplicaFixture
} from '../../../packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.js'

let replica: MongoReplicaFixture
const cleanups: (() => Promise<void>)[] = []
beforeAll(async () => {
  replica = await createMongoReplicaFixture()
}, 120000)
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})
afterAll(async () => {
  await replica?.close()
}, 60000)

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'reference-admission-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const scope = { ...fixtureChain, nodeId: 'reference-' + randomUUID() }
  await bootstrapMongoOverlay(replica.db, scope)
  const storage = new MongoOverlayStorage(replica.db, scope, { retainAdmissionHistory: true })
  cleanups.push(() => storage.close())
  const engine = await createReferenceEngine(storage)
  const options = {
    path: join(directory, 'provider.sqlite'),
    baseURL: 'http://127.0.0.1:4174/api',
    identityKey: new PrivateKey(71),
    producer: (context: Parameters<typeof createReferenceAdmissionProducer>[0]) =>
      createReferenceAdmissionProducer(context, { engine, storage })
  }
  const install = async (create: boolean) => {
    const provider = await createReferenceProvider({ ...options, create })
    cleanups.push(() => provider.close())
    return provider
  }
  return { directory, storage, engine, options, install }
}
const visible = async (provider: Awaited<ReturnType<typeof createReferenceProvider>>) => {
  const head = await provider.index.head()
  const page = await provider.index.snapshot(head.sequence, null, { records: 10, bytes: 1048576 })
  return page.rows.map(row => row.key).sort()
}
const keys = (...names: ('A' | 'AC' | 'Q' | 'X')[]) =>
  names.map(name => collectionOutputIndexKey(referenceEvidence(name).evidence)).sort()

it('projects real retained admission, preserves withdrawals and never resurrects a spent output', async () => {
  const f = await fixture(),
    provider = await f.install(true)
  const submit = vi.spyOn(f.engine, 'submit')
  await provider.publish()
  expect(provider.producerKind).toBe('admission')
  expect(await visible(provider)).toEqual(keys('A', 'Q', 'X'))
  expect(submit).toHaveBeenCalledTimes(3)
  for (const call of submit.mock.calls) expect(call[2]).toBe('historical-tx')
  await provider.replace()
  expect(await visible(provider)).toEqual(keys('AC', 'Q', 'X'))
  await provider.withdraw()
  expect(await visible(provider)).toEqual(keys('AC', 'X'))
  expect(
    await f.storage.findOutput(referenceEvidence('Q').evidence.txid, 0, REFERENCE_TOPIC, false)
  ).not.toBeNull()
  const before = await provider.index.head()
  await provider.reintroduce()
  expect(await visible(provider)).toEqual(keys('AC', 'X'))
  expect((await provider.index.head()).sequence).toBe(before.sequence)
  expect(submit).toHaveBeenCalledTimes(4)
  await provider.close()
  const reopened = await f.install(false)
  await reopened.recover()
  expect(await visible(reopened)).toEqual(keys('AC', 'X'))
}, 30000)

it('recovers the original command after a lost real admission reply without submitting that transaction again', async () => {
  const f = await fixture(),
    provider = await f.install(true)
  const original = f.engine.submit.bind(f.engine)
  const submit = vi.spyOn(f.engine, 'submit').mockImplementationOnce(async (...args) => {
    await original(...args)
    throw new OutputProtocolError('unavailable', 'Synthetic loss after actual admission')
  })
  await expect(provider.publish()).rejects.toMatchObject({ code: 'unavailable' })
  expect((await provider.index.head()).sequence).toBe('0')
  await expect(provider.replace()).rejects.toMatchObject({ code: 'conflict' })
  await provider.close()
  const reopened = await f.install(false)
  await reopened.recover()
  expect(await visible(reopened)).toEqual(keys('A', 'Q', 'X'))
  expect(submit).toHaveBeenCalledTimes(3)
}, 30000)

it('recovers a lost SQLite projection reply without appending a duplicate live group', async () => {
  const f = await fixture(),
    provider = await f.install(true)
  const commit = provider.index.commit.bind(provider.index)
  vi.spyOn(provider.index, 'commit').mockImplementationOnce(async change => {
    await commit(change)
    throw new OutputProtocolError('unavailable', 'Synthetic loss after actual index commit')
  })
  await expect(provider.publish()).rejects.toMatchObject({ code: 'unavailable' })
  expect((await provider.index.head()).sequence).toBe('1')
  await provider.close()
  const reopened = await f.install(false)
  await reopened.recover()
  expect(await visible(reopened)).toEqual(keys('A', 'Q', 'X'))
  expect((await reopened.index.head()).sequence).toBe('2')
}, 30000)

it('keeps physical ownership through a stalled admission, refuses overlap and drains before close', async () => {
  const f = await fixture(),
    provider = await f.install(true)
  const original = f.engine.submit.bind(f.engine)
  let release!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => {
      started = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  vi.spyOn(f.engine, 'submit').mockImplementationOnce(async (...args) => {
    started()
    await gate
    return original(...args)
  })
  const work = provider.publish()
  await entered
  await expect(provider.recover()).rejects.toMatchObject({ code: 'limited' })
  let closed = false
  const closing = provider.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  release()
  await expect(work).rejects.toMatchObject({ code: 'cancelled' })
  await closing
  const reopened = await f.install(false)
  await reopened.recover()
  expect(await visible(reopened)).toEqual(keys('A', 'Q', 'X'))
}, 30000)

it('delivers admission-driven progressive and live state to the same authenticated recovering native client', async () => {
  const f = await fixture()
  const server = await startReferenceServer({ ...f.options, create: true, id: 'one' })
  cleanups.push(() => server.close())
  await server.provider.publish()
  const open = async () =>
    createReferenceClient({
      account: 'alice',
      journal: new SQLiteJournal(join(f.directory, 'alice.sqlite'), 'alice'),
      controls: async (namespace, binding, initial) =>
        initial
          ? SQLiteOperationStateStore.create(
              join(f.directory, 'control.sqlite'),
              namespace,
              binding,
              initial.value,
              initial.limits
            )
          : SQLiteOperationStateStore.open(join(f.directory, 'control.sqlite'), namespace, binding)
    })
  let client = await open()
  cleanups.push(() => client.close())
  await client.connect(server.host, server.provider.manifest())
  await expect
    .poll(
      async () => {
        await client.runtime.flush()
        return (await client.core.read()).reconciled.memberships.filter(row => row.present).length
      },
      { timeout: 15000 }
    )
    .toBe(3)
  const first = await client.core.inspect()
  const pages = first.entries.flatMap(entry =>
    entry.body.kind === 'receive' && entry.body.batch.coverage.phase === 'snapshot'
      ? [entry.body.batch]
      : []
  )
  expect(pages.length).toBeGreaterThanOrEqual(2)
  expect(pages[0].coverage.status).toBe('partial')
  expect(pages.at(-1)?.coverage.status).toBe('complete')
  await client.close()
  await server.provider.replace()
  await server.provider.withdraw()
  client = await open()
  await client.connect(server.host)
  await expect
    .poll(
      async () => {
        await client.runtime.flush()
        return (await client.core.read()).assessments.some(
          row => row.outpoint.txid === referenceEvidence('A').evidence.txid && row.state === 'spent'
        )
      },
      { timeout: 15000 }
    )
    .toBe(true)
  await expect
    .poll(
      async () => {
        await client.runtime.flush()
        return (await client.core.read()).reconciled.memberships.find(
          row => row.outpoint.txid === referenceEvidence('Q').evidence.txid
        )?.present
      },
      { timeout: 15000 }
    )
    .toBe(false)
}, 30000)

it('refuses a changed stored subject and repairs only the original pending projection', async () => {
  const f = await fixture(),
    provider = await f.install(true),
    read = f.storage.findOutput.bind(f.storage)
  const poisoned = vi.spyOn(f.storage, 'findOutput').mockImplementation(async (...args) => {
    const output = await read(...args)
    return output && args[3] === false && args[4] === true
      ? { ...output, outputScript: [0x51] }
      : output
  })
  await expect(provider.publish()).rejects.toMatchObject({ code: 'unavailable' })
  expect((await provider.index.head()).sequence).toBe('0')
  poisoned.mockRestore()
  await provider.recover()
  expect(await visible(provider)).toEqual(keys('A', 'Q', 'X'))
}, 30000)

it('drains every started projection read after one fails, without releasing its physical slot', async () => {
  const f = await fixture(),
    provider = await f.install(true),
    read = f.storage.findOutput.bind(f.storage)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const injected = vi.spyOn(f.storage, 'findOutput').mockImplementation(async (...args) => {
    if (args[3] === false && args[4] === true) {
      if (args[0] === referenceEvidence('A').evidence.txid)
        throw new Error('Synthetic failed projection read')
      if (args[0] === referenceEvidence('Q').evidence.txid) {
        entered()
        await gate
      }
    }
    return read(...args)
  })
  let settled = false
  const work = provider.publish().finally(() => {
    settled = true
  })
  const rejected = expect(work).rejects.toThrow('Synthetic failed projection read')
  try {
    await started
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(provider.recover()).rejects.toMatchObject({ code: 'limited' })
  } finally {
    release()
  }
  await rejected
  expect((await provider.index.head()).sequence).toBe('0')
  injected.mockRestore()
  await provider.recover()
  expect(await visible(provider)).toEqual(keys('A', 'Q', 'X'))
}, 30000)

it('never creates a replacement command namespace when recovery custody is missing', async () => {
  const f = await fixture(),
    provider = await f.install(true)
  await provider.publish()
  const before = (await provider.index.head()).sequence
  await provider.close()
  const database = new DatabaseSync(f.options.path)
  try {
    database.exec(
      "DELETE FROM output_operation_state WHERE namespace = 'reference-admission-commands'"
    )
  } finally {
    database.close()
  }
  await expect(f.install(false)).rejects.toMatchObject({ code: 'reset-required' })
  const db = new DatabaseSync(f.options.path)
  try {
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM output_operation_state WHERE namespace = 'reference-admission-commands'"
        )
        .get()?.n
    ).toBe(0)
  } finally {
    db.close()
  }
  expect(before).toBe('2')
}, 30000)

it('opens only explicit isolated Mongo custody and refuses replacement after a missing marker', async () => {
  const database = 'output_reference_' + randomUUID().replaceAll('-', ''),
    uri = replica.uri.replace(/,127\.0\.0\.1:\d+/g, ''),
    options = { uri, database, identity: new PrivateKey(71).toPublicKey().toString(), role: 'one' }
  await expect(
    openReferenceMongo({ ...options, uri: 'mongodb://example.invalid:27017', create: true })
  ).rejects.toMatchObject({ code: 'invalid' })
  await expect(
    openReferenceMongo({ ...options, database: 'ordinary_data', create: true })
  ).rejects.toMatchObject({ code: 'invalid' })
  await expect(openReferenceMongo({ ...options, create: false })).rejects.toMatchObject({
    code: 'reset-required'
  })
  const created = await openReferenceMongo({ ...options, create: true })
  await created.close()
  const recovered = await openReferenceMongo({ ...options, create: false })
  await recovered.close()
  await replica.client.db(database).collection('reference_workbench_owners').deleteMany({})
  await expect(openReferenceMongo({ ...options, create: false })).rejects.toMatchObject({
    code: 'reset-required'
  })
}, 30000)
