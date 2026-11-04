import { afterEach, expect, it } from '@jest/globals'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteTransactionDomain } from '../src/storage/SQLiteTransactionDomain.js'
import {
  SQLiteLookupIndexStore,
  lookupIndexDefinition,
  sqliteLookupComposition
} from '../src/lookup/SQLiteLookupIndexStore.js'
import { sqliteLookupBridge } from '../src/lookup/SQLiteLookupBridge.js'
import { bootstrapSQLiteLookupSessions } from '../src/lookup/SQLiteLookupSessionBootstrap.js'
import { LookupSessionCodec } from '../src/lookup/LookupSessionCodec.js'
import type { SQLiteLookupSessions } from '../src/lookup/SQLiteLookupSessions.js'
import { liveFixture } from './live-lookup-fixture.js'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lookup-bootstrap-')),
    path = join(directory, 'db.sqlite')
  const database = new DatabaseSync(path),
    domain = new SQLiteTransactionDomain(database)
  cleanup.push(() => {
    domain.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const definition = lookupIndexDefinition(
    'current',
    { purpose: 'test' },
    {},
    { proposal: 'private' }
  )
  const index = new SQLiteLookupIndexStore(domain, definition),
    bridge = index[sqliteLookupBridge]()
  const f = liveFixture(),
    codec = new LookupSessionCodec({ ...f.selection, kind: 'lookup' })
  let now = '1000'
  const install = (create = true) =>
    bootstrapSQLiteLookupSessions(domain, bridge, codec, () => now, {}, create)
  return {
    database,
    domain,
    index,
    install,
    path,
    definition,
    codec,
    bridge,
    now: (value: string) => {
      now = value
    }
  }
}
it('atomically installs index and sessions under one real transaction then restores ordinary independent gates', async () => {
  const f = fixture(),
    statements: string[] = [],
    exec = f.database.exec.bind(f.database)
  f.database.exec = sql => {
    statements.push(sql)
    exec(sql)
  }
  const sessions = f.domain.transaction(() => {
    f.index[sqliteLookupComposition].initialize(true)
    return f.install()
  })
  expect(statements.filter(sql => sql.startsWith('BEGIN'))).toEqual(['BEGIN IMMEDIATE'])
  expect(statements.filter(sql => sql.startsWith('SAVEPOINT'))).toHaveLength(2)
  const epoch = await sessions.createEpoch()
  expect(epoch).toMatch(/^[a-f0-9]{64}$/)
  expect(statements.filter(sql => sql.startsWith('BEGIN'))).toHaveLength(2)
  await sessions.initializeGuard('private')
  expect(await sessions.guard('private')).toBe('0')
})
it('rolls back every newly installed namespace if a later compound participant fails', () => {
  const f = fixture()
  expect(() =>
    f.domain.transaction(() => {
      f.index[sqliteLookupComposition].initialize(true)
      f.install()
      throw new Error('later participant failed')
    })
  ).toThrow('later participant failed')
  const names = f.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  expect(names).toEqual([])
})
it('rolls back the index installation when session capacity is invalid', () => {
  const f = fixture()
  expect(() =>
    f.domain.transaction(() => {
      f.index[sqliteLookupComposition].initialize(true)
      bootstrapSQLiteLookupSessions(
        f.domain,
        f.bridge,
        f.codec,
        () => '1000',
        { sessions: 0 },
        true
      )
    })
  ).toThrow(expect.objectContaining({ code: 'invalid' }))
  expect(f.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([])
})
it('requires an active write domain and the same native connection', () => {
  const f = fixture(),
    other = fixture()
  expect(() => f.install()).toThrow('write transaction')
  expect(() =>
    f.domain.transaction(() =>
      bootstrapSQLiteLookupSessions(f.domain, other.bridge, f.codec, () => '1000', {}, true)
    )
  ).toThrow('same physical connection')
})
it('reopens original session inventory inside a compound transaction without reinitializing it', async () => {
  const f = fixture()
  const first = f.domain.transaction(() => {
    f.index[sqliteLookupComposition].initialize(true)
    return f.install()
  })
  const epoch = await first.createEpoch()
  await first.initializeGuard('private')
  const next = f.domain.transaction(() => f.install(false))
  expect(await next.guard('private')).toBe('0')
  expect(
    f.database
      .prepare('SELECT accepts_new FROM output_lookup_epochs WHERE namespace=? AND epoch=?')
      .get('current', epoch)
  ).toMatchObject({ accepts_new: 1 })
  expect(() => f.domain.transaction(() => f.install())).toThrow('already exists')
  expect(await next.guard('private')).toBe('0')
})
it('a returned companion from a subsequently rolled-back install never retains bootstrap reentry authority', async () => {
  const f = fixture()
  let leaked: SQLiteLookupSessions | undefined
  expect(() =>
    f.domain.transaction(() => {
      f.index[sqliteLookupComposition].initialize(true)
      leaked = f.install()
      throw new Error('reject installation')
    })
  ).toThrow('reject installation')
  await expect(leaked!.createEpoch()).rejects.toThrow()
})
