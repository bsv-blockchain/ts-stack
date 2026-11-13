import { afterEach, describe, expect, it } from '@jest/globals'
import type { ChildProcess } from 'node:child_process'
import { startLookupProcess } from './lookup-process-fixture.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SQLiteLookupIndex } from '../src/lookup/SQLiteLookupIndex.js'
import type { LookupIndexMutation } from '../src/lookup/LookupIndexCodec.js'

const binding = { service: 'records', epoch: 'process-tests' }
const processes = new Set<ChildProcess>()
const paths: string[] = []
const stores: SQLiteLookupIndex[] = []
const script = fileURLToPath(new URL('./fixtures/lookup-index-process.mjs', import.meta.url))
const mutation = (key = '01'): LookupIndexMutation => ({
  base: '0',
  evaluatedAt: '100',
  edits: [{ key, previous: null, next: { data: { label: key }, expiresAt: null } }],
  event: { reason: 'created' }
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lookup-process-'))
  paths.push(directory)
  const path = join(directory, 'index.db')
  const store = SQLiteLookupIndex.create(path, 'index', binding)
  stores.push(store)
  return { path, store }
}
function start(path: string, stage: string, change = mutation()) {
  return startLookupProcess(script, { path, binding, stage, mutation: change }, processes)
}

afterEach(async () => {
  await Promise.all(
    [...processes].map(
      child =>
        new Promise<void>(resolve => {
          child.once('exit', () => resolve())
          if (!child.kill('SIGKILL')) resolve()
        })
    )
  )
  processes.clear()
  for (const store of stores.splice(0)) await store.close()
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('lookup index process durability', () => {
  it.each(['before-group', 'after-commit'])('recovers after abrupt exit at %s', async stage => {
    const { path, store } = await fixture()
    await store.close()
    const child = start(path, stage)
    await child.started
    child.child.send('go')
    expect(await child.finished).toMatchObject({ signal: 'SIGKILL', timedOut: false })
    const recovered = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(recovered)
    expect((await recovered.head()).sequence).toBe(stage === 'before-group' ? '0' : '1')
    const result = await recovered.commit(mutation())
    expect(result.sequence).toBe('1')
    expect((await recovered.head()).retained).toMatchObject({ keys: 1, versions: 1, groups: 1 })
    expect((await recovered.row('01', '1'))?.revision).toBe('1')
  })

  it('restores the complete retained history after termination during compaction', async () => {
    const { path, store } = await fixture()
    await store.commit(mutation())
    await store.commit({
      ...mutation(),
      base: '1',
      evaluatedAt: '200',
      edits: [{ key: '01', previous: '1', next: null }]
    })
    const before = await store.head()
    await store.close()
    const child = start(path, 'during-compaction')
    await child.started
    child.child.send('go')
    expect(await child.finished).toMatchObject({ signal: 'SIGKILL', timedOut: false })
    const recovered = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(recovered)
    expect(await recovered.head()).toEqual(before)
    expect((await recovered.group('1')).sequence).toBe('1')
    expect(await recovered.row('01', '2')).toBeNull()
  })

  it('arbitrates a real independent-process write race with one coherent winner', async () => {
    const { path, store } = await fixture()
    await store.close()
    const contenders = [
      start(path, 'normal', mutation('01')),
      start(path, 'normal', mutation('02'))
    ]
    await Promise.all(contenders.map(child => child.started))
    for (const child of contenders) child.child.send('go')
    const exits = await Promise.all(contenders.map(child => child.finished))
    expect(exits.every(result => result.code === 0)).toBe(true)
    const outcomes = contenders
      .flatMap(child => child.messages)
      .filter(message => message.status !== 'ready')
    expect(outcomes.filter(message => message.status === 'committed')).toHaveLength(1)
    expect(outcomes.filter(message => message.code === 'conflict')).toHaveLength(1)
    const recovered = SQLiteLookupIndex.open(path, 'index', binding)
    stores.push(recovered)
    expect((await recovered.head()).retained).toMatchObject({ keys: 1, versions: 1, groups: 1 })
    expect((await recovered.snapshot('1', null, { records: 10, bytes: 65536 })).rows).toHaveLength(
      1
    )
  })
})
