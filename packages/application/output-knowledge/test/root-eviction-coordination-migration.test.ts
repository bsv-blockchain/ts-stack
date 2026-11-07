import { expect, it } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { SQLiteRootEvictionStore } from '../src/root-eviction/SQLiteRootEvictionStore.js'
import { rootConfiguration } from '../src/root-eviction/RootEvictionCodec.js'
import { apply, clock, requester, selected, signed } from './root-eviction-fixture.js'
import {
  coordinatedFixture,
  coordinatedRequest,
  contractSelection,
  coordinationGuard
} from './root-eviction-coordination-fixture.js'

const error = (code: string) =>
  expect.objectContaining({ code, message: expect.stringMatching(/\S/) })
function seal(path: string) {
  const db = new DatabaseSync(path)
  try {
    return db.prepare('SELECT configuration FROM root_meta WHERE id=1').get()!.configuration
  } finally {
    db.close()
  }
}

it('requires an explicit format upgrade, preserves all existing history and fences already-open older connections', async () => {
  const f = await coordinatedFixture({ coordination: undefined })
  let upgraded: SQLiteRootEvictionStore | undefined, retry: SQLiteRootEvictionStore | undefined
  try {
    const body = coordinatedRequest(),
      original = await apply(f.store, body)
    const before = await f.store.head(),
      intents = await f.store.projections(10)
    const configuration = { ...f.configuration, coordination: {} }
    expect(() => SQLiteRootEvictionStore.open(f.path, configuration)).toThrow(
      error('context-changed')
    )
    expect(seal(f.path)).toBe(rootConfiguration(f.configuration).seal)
    upgraded = SQLiteRootEvictionStore.upgradeCoordination(f.path, configuration)
    expect(seal(f.path)).toBe(rootConfiguration(configuration).seal)
    expect(await upgraded.head()).toEqual(before)
    expect(await upgraded.result(requester, body.requestId, '150')).toEqual(original)
    expect(await upgraded.projections(10)).toEqual(intents)
    expect(await upgraded.basis(original.outcomes[0].decisionId!)).toMatchObject({
      requester,
      requestDigest: original.requestDigest,
      liftedBy: null
    })
    await expect(f.store.head()).rejects.toMatchObject(error('context-changed'))
    await expect(f.store.get(requester, body.requestId)).rejects.toMatchObject(
      error('context-changed')
    )
    await expect(
      f.store.retain(signed(coordinatedRequest('old_writer_request_001')), requester, clock)
    ).rejects.toMatchObject(error('context-changed'))
    let authorized = false,
      queued = false
    await expect(
      f.store.enqueue(
        { revision: before.revision, targets: [], bytes: new Uint8Array([1]) },
        () => {
          authorized = true
          return true
        },
        () => {
          queued = true
        }
      )
    ).rejects.toMatchObject(error('context-changed'))
    expect(authorized).toBe(false)
    expect(queued).toBe(false)
    expect(() => SQLiteRootEvictionStore.open(f.path, f.configuration)).toThrow(
      error('context-changed')
    )
    retry = SQLiteRootEvictionStore.upgradeCoordination(f.path, configuration)
    expect(await retry.head()).toEqual(before)
    const selection = contractSelection()
    await expect(
      retry.retainCoordinated(signed(body), requester, selection, f.contracts, coordinationGuard())
    ).rejects.toMatchObject(error('unavailable'))
    expect(await retry.get(requester, 'old_writer_request_001')).toBeUndefined()
    await retry.retainCoordinated(
      signed(coordinatedRequest('new_coordinated_request')),
      requester,
      selection,
      f.contracts,
      coordinationGuard()
    )
    expect(await retry.get(requester, body.requestId)).toBeDefined()
  } finally {
    await retry?.close()
    await upgraded?.close()
    await f.cleanup()
  }
})

it('never creates a missing journal, auto-adopts different capacities or resets an identity during upgrade', async () => {
  const f = await coordinatedFixture({ coordination: undefined })
  try {
    const original = seal(f.path)
    expect(() =>
      SQLiteRootEvictionStore.upgradeCoordination(join(f.directory, 'missing.db'), {
        ...f.configuration,
        coordination: {}
      })
    ).toThrow()
    expect(() => SQLiteRootEvictionStore.upgradeCoordination(f.path, f.configuration)).toThrow(
      error('invalid')
    )
    for (const configuration of [
      { ...f.configuration, root: requester, coordination: {} },
      {
        ...f.configuration,
        chain: { ...f.configuration.chain, genesisHash: 'cc'.repeat(32) },
        coordination: {}
      },
      { ...f.configuration, capacity: { requests: 3 }, coordination: {} }
    ])
      expect(() => SQLiteRootEvictionStore.upgradeCoordination(f.path, configuration)).toThrow(
        error('context-changed')
      )
    expect(seal(f.path)).toBe(original)
    expect(await f.store.head()).toMatchObject({ revision: '0' })
  } finally {
    await f.cleanup()
  }
})

it('rolls back the new table and seal when existing inventory fails migration validation', async () => {
  const f = await coordinatedFixture({ coordination: undefined })
  try {
    const body = coordinatedRequest()
    await f.store.retain(signed(body), requester, clock)
    const oldSeal = seal(f.path),
      db = new DatabaseSync(f.path)
    db.exec('UPDATE root_requests SET bytes=bytes+1')
    db.close()
    expect(() =>
      SQLiteRootEvictionStore.upgradeCoordination(f.path, { ...f.configuration, coordination: {} })
    ).toThrow(error('unavailable'))
    expect(seal(f.path)).toBe(oldSeal)
    const check = new DatabaseSync(f.path)
    expect(
      check.prepare("SELECT name FROM sqlite_schema WHERE name='root_contracts'").get()
    ).toBeUndefined()
    expect(check.prepare('SELECT count(*) AS n FROM root_requests').get()!.n).toBe(1)
    check.close()
  } finally {
    await f.cleanup()
  }
})

it('refuses to repair a missing format2 contract table by silently creating an empty replacement', async () => {
  const f = await coordinatedFixture()
  try {
    const db = new DatabaseSync(f.path)
    db.exec('DROP TABLE root_contracts')
    db.close()
    expect(() => SQLiteRootEvictionStore.open(f.path, f.configuration)).toThrow()
    expect(() => SQLiteRootEvictionStore.upgradeCoordination(f.path, f.configuration)).toThrow()
    const check = new DatabaseSync(f.path)
    expect(
      check.prepare("SELECT name FROM sqlite_schema WHERE name='root_contracts'").get()
    ).toBeUndefined()
    check.close()
  } finally {
    await f.cleanup()
  }
})

it('rejects invalid coordination capacities and retains the exact default format1 seal', () => {
  const base = { root: requester, chain: selected().outpoint.chain }
  expect(JSON.parse(rootConfiguration(base).seal)).toMatchObject({ format: 'root-eviction/1' })
  expect(rootConfiguration({ ...base, coordination: undefined }).seal).toBe(
    rootConfiguration(base).seal
  )
  for (const coordination of [
    { contractBytes: 0 },
    { contractBytes: -1 },
    { contractBytes: 0.5 },
    { contractBytes: 67108865 },
    { contractBytes: NaN },
    { contractBytes: 1, unknown: true }
  ])
    expect(() => rootConfiguration({ ...base, coordination })).toThrow(error('invalid'))
  const configured = rootConfiguration({ ...base, coordination: {} })
  expect(configured.coordination).toEqual({ contractBytes: 67108864 })
  expect(Object.isFrozen(configured.coordination)).toBe(true)
})
