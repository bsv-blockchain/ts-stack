import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthFetch, CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { SQLiteJournal } from '@bsv/output-knowledge/sqlite'
import { SQLiteOperationStateStore } from '@bsv/output-knowledge/operations/sqlite'
import { createReferenceClient } from '../src/referenceClient.js'
import { startReferenceServer } from '../src/referenceServer.js'
import { referenceEvidence } from '../src/fixtureChain.js'

// A live update can require multiple authenticated one-second long-poll rounds.
// The assertion deadline must cover that protocol work, not Vitest's short default.
const eventually = <T>(read: () => Promise<T>) =>
  expect.poll(read, { timeout: 15000, interval: 50 })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

it('bounds work before authentication and preserves no-store headers on rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'output-reference-rate-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const server = await startReferenceServer({
    path: join(directory, 'provider.sqlite'),
    create: true,
    id: 'one',
    identityKey: new PrivateKey(71)
  })
  cleanups.push(() => server.close())
  for (let batch = 0; batch < 20; batch++) {
    const responses = await Promise.all(
      Array.from({ length: 30 }, async () => {
        const response = await fetch(server.origin + '/demo/config')
        await response.text()
        return response.status
      })
    )
    expect(responses).toEqual(Array.from({ length: 30 }, () => 200))
  }
  const response = await fetch(server.origin + '/demo/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'publish' })
  })
  expect(response.status).toBe(429)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await server.provider.index.head()).sequence).toBe('0')
}, 30000)

it('refuses anonymous and unrelated authenticated producer commands without changing the index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'output-reference-access-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const server = await startReferenceServer({
    path: join(directory, 'provider.sqlite'),
    create: true,
    id: 'one',
    identityKey: new PrivateKey(71)
  })
  cleanups.push(() => server.close())
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'publish' })
  }
  expect((await fetch(server.origin + '/demo/command', request)).status).toBe(401)
  const unrelated = new AuthFetch(new CompletedProtoWallet(new PrivateKey(93)))
  const rejected = await unrelated.fetch(server.origin + '/demo/command', {
    ...request,
    allowPayments: false,
    requireMutualAuth: true,
    expectedIdentityKey: server.host.identity
  })
  expect(rejected.status).toBe(401)
  expect((await server.provider.index.head()).sequence).toBe('0')
})

it('continues an original source after the provider reopens its database at the same endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'output-reference-server-restart-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const options = {
    path: join(directory, 'provider.sqlite'),
    id: 'one',
    identityKey: new PrivateKey(71)
  }
  let server = await startReferenceServer({ ...options, create: true })
  cleanups.push(() => server.close())
  const client = await createReferenceClient({
    account: 'alice',
    journal: new SQLiteJournal(join(directory, 'alice.sqlite'), 'alice'),
    controls: async (namespace, binding, initial) => {
      if (!initial) throw new Error('Initial fixture control is required')
      return SQLiteOperationStateStore.create(
        join(directory, 'control.sqlite'),
        namespace,
        binding,
        initial.value,
        initial.limits
      )
    }
  })
  cleanups.push(() => client.close())
  await client.connect(server.host, server.provider.manifest())
  await server.provider.publish()
  await eventually(async () => {
    await client.runtime.flush()
    return (await client.core.read()).reconciled.memberships.filter(row => row.present).length
  }).toBe(3)
  await client.disconnect()
  const originalEpoch = (await client.core.read()).reconciled.memberships[0].scope.epoch
  const port = Number(new URL(server.origin).port)
  await server.close()
  server = await startReferenceServer({ ...options, port, create: false })
  await server.provider.replace()
  await client.connect(server.host)
  await eventually(async () => {
    await client.runtime.flush()
    return (await client.core.read()).assessments.some(
      row => row.outpoint.txid === referenceEvidence('A').evidence.txid && row.state === 'spent'
    )
  }).toBe(true)
  expect(
    (await client.core.read()).reconciled.memberships.every(
      row => row.scope.epoch === originalEpoch
    )
  ).toBe(true)
}, 30000)

it('progressively ingests a populated snapshot within a two-observation page bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'output-reference-pages-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const server = await startReferenceServer({
    path: join(directory, 'provider.sqlite'),
    create: true,
    id: 'one',
    identityKey: new PrivateKey(71)
  })
  cleanups.push(() => server.close())
  await server.provider.publish()
  const client = await createReferenceClient({
    account: 'alice',
    journal: new SQLiteJournal(join(directory, 'alice.sqlite'), 'alice'),
    controls: async (namespace, binding, initial) => {
      if (!initial) throw new Error('Initial fixture control is required')
      return SQLiteOperationStateStore.create(
        join(directory, 'control.sqlite'),
        namespace,
        binding,
        initial.value,
        initial.limits
      )
    }
  })
  cleanups.push(() => client.close())
  await client.connect(server.host, server.provider.manifest())
  await eventually(async () => {
    await client.runtime.flush()
    return (await client.core.read()).reconciled.memberships.filter(row => row.present).length
  }).toBe(3)
  const history = await client.core.inspect()
  const pages = history.entries.flatMap(entry =>
    entry.body.kind === 'receive' && entry.body.batch.coverage.phase === 'snapshot'
      ? [entry.body.batch]
      : []
  )
  expect(pages.length).toBeGreaterThanOrEqual(2)
  expect(pages[0].coverage.status).toBe('partial')
  expect(pages.at(-1)?.coverage.status).toBe('complete')
  for (const page of pages)
    expect(page.groups.flatMap(group => group.observations).length).toBeLessThanOrEqual(2)
}, 30000)

it('two authenticated SQLite clients learn a real spend and recover a missed source withdrawal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'output-reference-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const server = await startReferenceServer({
    path: join(directory, 'provider.sqlite'),
    create: true,
    id: 'one',
    identityKey: new PrivateKey(71)
  })
  cleanups.push(() => server.close())
  const createClient = (account: 'alice' | 'bob') =>
    createReferenceClient({
      account,
      journal: new SQLiteJournal(join(directory, account + '.sqlite'), account),
      controls: async (namespace, binding, initial) => {
        const path = join(directory, account + '-control.sqlite')
        return initial
          ? SQLiteOperationStateStore.create(
              path,
              namespace,
              binding,
              initial.value,
              initial.limits
            )
          : SQLiteOperationStateStore.open(path, namespace, binding)
      }
    })
  const alice = await createClient('alice')
  let bob = await createClient('bob')
  cleanups.push(
    () => alice.close(),
    () => bob.close()
  )
  await alice.connect(server.host, server.provider.manifest())
  await bob.connect(server.host, server.provider.manifest())
  await server.provider.publish()
  async function state(client: typeof alice) {
    await client.runtime.flush()
    return client.core.read()
  }
  await eventually(
    async () =>
      (await state(alice)).facts.filter(row =>
        ['A', 'Q'].some(name => referenceEvidence(name as 'A' | 'Q').evidence.txid === row.txid)
      ).length
  ).toBe(2)
  await eventually(
    async () =>
      (await state(bob)).facts.filter(row =>
        ['A', 'Q'].some(name => referenceEvidence(name as 'A' | 'Q').evidence.txid === row.txid)
      ).length
  ).toBe(2)
  await bob.close()
  await server.provider.replace()
  await server.provider.withdraw()
  const original = referenceEvidence('A').evidence.txid
  const independent = referenceEvidence('Q').evidence.txid
  await eventually(async () =>
    (await state(alice)).assessments.some(
      row => row.outpoint.txid === original && row.state === 'spent'
    )
  ).toBe(true)
  bob = await createClient('bob')
  await bob.connect(server.host)
  await eventually(async () =>
    (await state(bob)).facts.some(row => row.txid === referenceEvidence('AC').evidence.txid)
  ).toBe(true)
  await eventually(
    async () =>
      (await state(bob)).reconciled.memberships.find(row => row.outpoint.txid === independent)
        ?.present
  ).toBe(false)
  const recovered = await state(bob)
  expect(
    recovered.assessments.some(row => row.outpoint.txid === original && row.state === 'spent')
  ).toBe(true)
  expect(
    recovered.assessments.some(row => row.outpoint.txid === independent && row.state === 'spent')
  ).toBe(false)
  expect(
    recovered.reconciled.memberships.find(row => row.outpoint.txid === independent)?.present
  ).toBe(false)
  await server.provider.reintroduce()
  await eventually(
    async () =>
      (await state(bob)).reconciled.memberships.find(row => row.outpoint.txid === original)?.present
  ).toBe(true)
  expect(
    (await state(bob)).assessments.some(
      row => row.outpoint.txid === original && row.state === 'spent'
    )
  ).toBe(true)
}, 30000)
