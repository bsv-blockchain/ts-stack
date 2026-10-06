import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { readIdentity, readIdentities, identityDDL, type SourceIdentity } from './snapshotSqliteIdentity'
import { readSqliteIdentityObservations, readSqliteIndexObservations } from './snapshotSqliteIdentityObservations'

const sources: SourceIdentity[] = [
  { table: 'identity_a', key: 'id', owner: 'owner' },
  { table: 'identity_b', key: 'id', owner: 'owner' }
]
async function fixture(filename = ':memory:'): Promise<Knex> {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  try {
    if (filename !== ':memory:') await k.raw('PRAGMA journal_mode=WAL')
    await k.raw(
      'CREATE TABLE identity_a(id INTEGER PRIMARY KEY,owner INTEGER NOT NULL,code VARCHAR(10) COLLATE NOCASE UNIQUE)'
    )
    await k.raw(
      'CREATE TABLE identity_b(id INTEGER PRIMARY KEY,owner INTEGER NOT NULL,code VARCHAR(10) COLLATE RTRIM UNIQUE)'
    )
    return k
  } catch (error) {
    await k.destroy()
    throw error
  }
}
// The independent oracle uses the retained original individual fresh PRAGMAs
// on this same healthy fixture. It does not qualify another driver/platform.
async function original(k: Knex, values = sources) {
  const result = []
  for (const source of values) result.push(await readIdentity(k, source))
  return result
}

test('two fresh bounded metadata statements retain every original identity and DDL byte', async () => {
  const k = await fixture()
  try {
    const queries: string[] = []
    const observer = (query: { sql: string }) => queries.push(query.sql)
    k.on('query', observer)
    const actual = await readIdentities(k, sources)
    k.off('query', observer)
    expect(queries.filter(sql => sql.includes('pragma_table_xinfo'))).toHaveLength(1)
    expect(queries.filter(sql => sql.includes('pragma_index_list'))).toHaveLength(1)
    expect(actual).toEqual(await original(k))
    expect(actual.map(identityDDL)).toEqual((await original(k)).map(identityDDL))
    expect(actual[0].columns[0]).toHaveProperty('cid')
    expect(actual[0].columns[0]).toHaveProperty('dflt_value')
    expect(actual[0].columns[0]).not.toHaveProperty('sourceOrdinal')
  } finally {
    await k.destroy()
  }
})

test('valid unique-index changes and rollback are read afresh', async () => {
  const k = await fixture()
  try {
    const before = await readIdentities(k, sources)
    await expect(
      k.transaction(async t => {
        await t.raw('CREATE UNIQUE INDEX extra_identity ON identity_a(owner,code)')
        expect(await readIdentities(t, sources)).toEqual(await original(t))
        expect(await readIdentities(t, sources)).not.toEqual(before)
        throw new Error('owned ordinary rollback')
      })
    ).rejects.toThrow('owned ordinary rollback')
    expect(await readIdentities(k, sources)).toEqual(before)
    await k.raw('CREATE UNIQUE INDEX committed_identity ON identity_a(owner,code)')
    expect(await readIdentities(k, sources)).toEqual(await original(k))
    expect(await readIdentities(k, sources)).not.toEqual(before)
  } finally {
    await k.destroy()
  }
})

test('independent valid WAL DDL retains the pinned source view until it ends', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ts544-identity-observations-'))
  const filename = join(folder, 'owned.sqlite')
  let k: Knex | undefined
  let writer: Knex | undefined
  try {
    k = await fixture(filename)
    writer = knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
    const independent = writer
    const before = await readIdentities(k, sources)
    await k.transaction(async t => {
      await t('identity_a').select('id').limit(1)
      await independent.raw('CREATE UNIQUE INDEX independent_identity ON identity_a(owner,code)')
      expect(await readIdentities(t, sources)).toEqual(before)
      expect(await original(t)).toEqual(before)
    })
    expect(await readIdentities(k, sources)).toEqual(await original(k))
    expect(await readIdentities(k, sources)).not.toEqual(before)
  } finally {
    if (writer !== undefined) await writer.destroy()
    if (k !== undefined) await k.destroy()
    await rm(folder, { recursive: true, force: true })
  }
})

test('temporary source metadata has the exact original PRAGMA lookup and order', async () => {
  const k = await fixture()
  try {
    await k.raw('CREATE TEMP TABLE identity_a(id INTEGER PRIMARY KEY,owner INTEGER NOT NULL,alias VARCHAR(20) UNIQUE)')
    expect(await readIdentities(k, sources)).toEqual(await original(k))
  } finally {
    await k.destroy()
  }
})

test('the first unsupported numeric identity retains its original rejection identity and order', async () => {
  const k = await fixture()
  try {
    await k.raw('DROP TABLE identity_a')
    await k.raw('CREATE TABLE identity_a(id INTEGER,owner INTEGER,PRIMARY KEY(id,owner))')
    await k.raw('DROP TABLE identity_b')
    await expect(readIdentities(k, sources)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
    await expect(original(k)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
    await expect(readIdentities(k, sources)).rejects.toThrow('Unsupported numeric identity')
    await expect(original(k)).rejects.toThrow('Unsupported numeric identity')
  } finally {
    await k.destroy()
  }
})

test('nonoptimized driver selection retains the original individual PRAGMA results', async () => {
  const k = await fixture()
  const client = k.client.config.client
  try {
    k.client.config.client = 'sqlite3'
    expect(
      await readSqliteIdentityObservations(
        k,
        sources.map(source => source.table)
      )
    ).toBeUndefined()
    expect(await readIdentities(k, sources)).toEqual(await original(k))
  } finally {
    k.client.config.client = client
    await k.destroy()
  }
})

test('empty and seventeen-source constructions retain the original fallback', async () => {
  const k = await fixture()
  try {
    const extended = Array.from({ length: 17 }, () => ({ ...sources[0] }))
    expect(await readSqliteIdentityObservations(k, [])).toBeUndefined()
    expect(await readIdentities(k, [])).toEqual([])
    expect(
      await readSqliteIdentityObservations(
        k,
        extended.map(source => source.table)
      )
    ).toBeUndefined()
    expect(await readIdentities(k, extended)).toEqual(await original(k, extended))
  } finally {
    await k.destroy()
  }
})

test('a healthy quoted source name retains the original PRAGMA path', async () => {
  const k = await fixture()
  try {
    await k.raw('CREATE TABLE "identity spaced"(id INTEGER PRIMARY KEY,owner INTEGER NOT NULL)')
    const quoted = [{ table: 'identity spaced', key: 'id', owner: 'owner' }]
    expect(
      await readSqliteIdentityObservations(
        k,
        quoted.map(source => source.table)
      )
    ).toBeUndefined()
    expect(await readIdentities(k, quoted)).toEqual(await original(k, quoted))
  } finally {
    await k.destroy()
  }
})

test('a source changed after observation selection falls back to its actual current table', async () => {
  const k = await fixture()
  try {
    const current = [{ ...sources[0] }]
    const change = (query: { sql: string }) => {
      if (query.sql.includes('pragma_table_xinfo')) current[0].table = 'identity_b'
    }
    k.on('query', change)
    const actual = await readIdentities(k, current)
    k.off('query', change)
    expect(actual).toEqual(await original(k, current))
    expect(actual[0].source.table).toBe('identity_b')
  } finally {
    await k.destroy()
  }
})

test('mutating a returned metadata value cannot affect a subsequent construction', async () => {
  const k = await fixture()
  try {
    const actual = await readIdentities(k, sources)
    actual[0].columns[0].name = 'changed_returned_value'
    expect(await readIdentities(k, sources)).toEqual(await original(k))
  } finally {
    await k.destroy()
  }
})

test('repeated source names retain independent ordered metadata groups', async () => {
  const k = await fixture()
  try {
    const repeated = [sources[1], sources[0], sources[1]]
    const actual = await readIdentities(k, repeated)
    expect(actual).toEqual(await original(k, repeated))
    actual[0].columns[0].name = 'changed_first_group'
    expect(actual[2].columns[0].name).toBe('id')
  } finally {
    await k.destroy()
  }
})

test('two bounded index names use one fresh exact index-part group', async () => {
  const k = await fixture()
  try {
    await k.raw('CREATE UNIQUE INDEX "identity quoted index" ON identity_a(owner,code COLLATE RTRIM)')
    const queries: string[] = []
    const observe = (query: { sql: string }) => queries.push(query.sql)
    const names = ((await k.raw('PRAGMA index_list(identity_a)')) as Array<{ name: string; unique: number }>)
      .filter(row => row.unique !== 0)
      .map(row => row.name)
    k.on('query', observe)
    const observed = await readSqliteIndexObservations(k, names)
    k.off('query', observe)
    const actual = await readIdentities(k, [sources[0]])
    expect(queries.filter(sql => sql.includes('pragma_index_xinfo'))).toHaveLength(1)
    expect(queries.filter(sql => sql.startsWith('PRAGMA index_xinfo'))).toHaveLength(0)
    expect(actual).toEqual(await original(k, [sources[0]]))
    expect(actual.map(identityDDL)).toEqual((await original(k, [sources[0]])).map(identityDDL))
    for (const [index, name] of names.entries()) {
      expect(observed?.[index].parts).toEqual(await k.raw('PRAGMA index_xinfo(??)', [name]))
      expect(observed?.[index].parts[0]).not.toHaveProperty('sourceOrdinal')
    }
  } finally {
    await k.destroy()
  }
})

test('seventeen current unique constraints retain individual fresh index reads', async () => {
  const k = await fixture()
  try {
    for (let index = 0; index < 16; index++)
      await k.raw('CREATE UNIQUE INDEX ?? ON identity_a(owner,code)', ['extra_' + index])
    const names = ((await k.raw('PRAGMA index_list(identity_a)')) as Array<{ name: string }>).map(row => row.name)
    expect(names).toHaveLength(17)
    expect(await readSqliteIndexObservations(k, names)).toBeUndefined()
    expect(await readIdentities(k, [sources[0]])).toEqual(await original(k, [sources[0]]))
  } finally {
    await k.destroy()
  }
})

test('empty and nonoptimized index groups preserve fallback without executing metadata SQL', async () => {
  const k = await fixture(),
    client = k.client.config.client
  try {
    expect(await readSqliteIndexObservations(k, [])).toBeUndefined()
    k.client.config.client = 'sqlite3'
    expect(await readSqliteIndexObservations(k, ['sqlite_autoindex_identity_a_1'])).toBeUndefined()
  } finally {
    k.client.config.client = client
    await k.destroy()
  }
})

test('returned index metadata is independent across duplicate groups and future observations', async () => {
  const k = await fixture()
  try {
    const names = ['sqlite_autoindex_identity_a_1', 'sqlite_autoindex_identity_a_1']
    const observed = await readSqliteIndexObservations(k, names)
    expect(observed).toBeDefined()
    observed![0].parts[0].name = 'mutated_returned_part'
    expect(observed![1].parts[0].name).toBe('code')
    expect((await readSqliteIndexObservations(k, names))?.[0].parts).toEqual(
      await k.raw('PRAGMA index_xinfo(??)', [names[0]])
    )
  } finally {
    await k.destroy()
  }
})
