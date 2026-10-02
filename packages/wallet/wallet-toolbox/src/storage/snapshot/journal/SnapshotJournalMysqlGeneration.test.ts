import * as observers from './SnapshotJournalMysqlObservers'
import { knex, type Knex } from 'knex'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  completeSnapshotJournalMysqlGeneration,
  installSnapshotJournalMysqlGeneration,
  readSnapshotJournalMysqlGeneration
} from './SnapshotJournalMysqlGeneration'
import { readSnapshotJournalMysqlBinding } from './SnapshotJournalMysqlSource'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
jest.mock('./SnapshotJournalMysqlSource', () => ({ readSnapshotJournalMysqlBinding: jest.fn() }))
interface Capture {
  sql: string
  bindings?: unknown[]
  rows: Array<Record<string, unknown>>
}
const captured: Capture[] = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../test/fixtures/snapshotJournal/mysql-generation-metadata-fixture.json'),
    'utf8'
  )
)
const nativeState = JSON.parse(
  readFileSync(join(__dirname, '../../../../test/fixtures/snapshotJournal/mysql-generation-state-fixture.json'), 'utf8')
) as Record<string, string | number>
const ceiling = snapshotJournalRevision('9223372036854775807')
const readBinding = jest.mocked(readSnapshotJournalMysqlBinding)
const nativeDdl: { epoch: string; ddl: Array<{ sql: string; bindings: unknown[] }> } = JSON.parse(
  readFileSync(join(__dirname, '../../../../test/fixtures/snapshotJournal/mysql-generation-ddl-fixture.json'), 'utf8')
)
async function fixture() {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  await database.raw(
    'CREATE TABLE snapshot_journal_generation(id INTEGER,version INTEGER,epoch TEXT,source TEXT,plan TEXT,ceiling TEXT,nextObject INTEGER,complete INTEGER)'
  )
  await database('snapshot_journal_generation').insert(nativeState)
  await database.raw('CREATE TABLE snapshot_journal_clock(id INTEGER,ceiling TEXT)')
  await database('snapshot_journal_clock').insert({ id: 1, ceiling })
  await database.raw('CREATE TABLE snapshot_journal_bootstrap(id INTEGER,stream INTEGER,cursor TEXT)')
  await database('snapshot_journal_bootstrap').insert({ id: 1, stream: 17, cursor: null })
  await database.raw('CREATE TABLE snapshot_journal_invalid(id INTEGER,reason TEXT)')
  await database.raw('CREATE TABLE snapshot_journal_events(revision TEXT)')
  const metadata = structuredClone(captured),
    writes: string[] = []
  database.on('query', query => {
    if (/^(?:insert|update|delete|create|alter|drop)/i.test(query.sql)) writes.push(query.sql)
  })
  readBinding.mockResolvedValue(String(nativeState.source))
  let activeEpoch = String(nativeState.epoch),
    available: Set<string> | undefined
  const fault = {
    phase: '',
    fired: false,
    zeroNext: false,
    zeroComplete: false,
    beforeTransaction: undefined as undefined | ((t: Knex) => Promise<void>)
  }
  const fail = (phase: string): void => {
    if (fault.phase === phase && !fault.fired) {
      fault.fired = true
      throw new Error('lost reply at ' + phase)
    }
  }
  const raw = jest.fn((sql: string, values?: unknown[]) => {
    if (sql === 'CAST(ceiling AS CHAR) ceiling') return database.raw(sql)
    if (sql === 'SELECT VERSION() version') return Promise.resolve([[{ version: '8.4.0' }]])
    const name = /^CREATE (?:TABLE|TRIGGER) (snapshot_journal_[A-Za-z0-9_]+)/.exec(sql)?.[1]
    if (name)
      return (async () => {
        fail('before:' + name)
        const reference = nativeDdl.ddl.find(
          entry => /^CREATE (?:TABLE|TRIGGER) (snapshot_journal_[A-Za-z0-9_]+)/.exec(entry.sql)?.[1] === name
        )
        if (!reference || !available || available.has(name)) throw new Error('Unowned fixture DDL')
        if (name === 'snapshot_journal_generation') activeEpoch = String(values?.[0])
        expect(sql).toBe(reference.sql.replaceAll(nativeDdl.epoch, activeEpoch))
        expect(values ?? []).toEqual(
          name === 'snapshot_journal_generation'
            ? [activeEpoch, nativeState.source, nativeState.plan, ceiling]
            : reference.bindings
        )
        if (name === 'snapshot_journal_generation')
          await database(name).insert({
            id: 1,
            version: 1,
            epoch: activeEpoch,
            source: values![1],
            plan: values![2],
            ceiling: values![3],
            nextObject: 0,
            complete: 0
          })
        if (name === 'snapshot_journal_clock') await database(name).insert({ id: 1, ceiling: values![0] })
        if (name === 'snapshot_journal_bootstrap') await database(name).insert({ id: 1, stream: 0, cursor: null })
        available.add(name)
        fail('after:' + name)
        return {}
      })()
    const found = metadata.find(
      entry => entry.sql === sql && JSON.stringify(entry.bindings ?? []) === JSON.stringify(values ?? [])
    )
    if (!found) throw new Error('Unexpected native metadata request: ' + sql)
    let result = JSON.parse(JSON.stringify(found.rows).replaceAll(String(nativeState.epoch), activeEpoch)) as Array<
      Record<string, unknown>
    >
    if (available) {
      if (sql.includes('LOWER(LEFT(')) result = result.filter(row => available!.has(String(row.name)))
      else {
        const owned = values?.find(value => typeof value === 'string' && value.startsWith('snapshot_journal_'))
        if (typeof owned === 'string' && !available.has(owned)) result = []
      }
    }
    return Promise.resolve([result])
  })
  const wrap = (connection: Knex, isTransaction = false): Knex =>
    Object.assign(
      (table: string) => {
        const builder = connection(table)
        // Only the native fixture establishes MySQL row-lock behavior. This fixture
        // executes state DML/rollback in SQLite and owns exact native DDL/metadata.
        builder.forUpdate = () => builder
        builder.noWait = () => builder
        const update = builder.update.bind(builder)
        builder.update = ((patch: Record<string, unknown>) =>
          (async () => {
            if ('nextObject' in patch && fault.zeroNext) return 0
            if ('complete' in patch && fault.zeroComplete) return 0
            if ('complete' in patch) fail('complete:before')
            const changed = await update(patch)
            if ('nextObject' in patch) fail('ack:' + String(patch.nextObject))
            if ('complete' in patch) fail('complete:after')
            return changed
          })()) as typeof builder.update
        return builder
      },
      {
        client: { config: { client: 'mysql2' } },
        isTransaction,
        raw,
        transaction: async (callback: (t: Knex) => Promise<unknown>) =>
          await connection.transaction(async t => {
            await fault.beforeTransaction?.(t)
            return await callback(wrap(t, true))
          })
      }
    ) as unknown as Knex
  const k = wrap(database)
  const fresh = async (): Promise<void> => {
    for (const table of [
      'snapshot_journal_generation',
      'snapshot_journal_clock',
      'snapshot_journal_bootstrap',
      'snapshot_journal_invalid',
      'snapshot_journal_events'
    ])
      await database(table).delete()
    available = new Set()
    writes.length = 0
  }
  const rows = (fragment: string, table?: string): Array<Record<string, unknown>> => {
    const entry = metadata.find(
      entry => entry.sql.includes(fragment) && (table === undefined || entry.bindings?.includes(table))
    )
    if (!entry) throw new Error('Missing native fixture metadata: ' + fragment)
    return entry.rows
  }
  return { database, k, metadata, rows, writes, raw, fresh, fault }
}
test('native metadata resumes the complete persisted generation without writes', async () => {
  const f = await fixture()
  try {
    expect(await readSnapshotJournalMysqlGeneration(f.k, ceiling)).toEqual({
      source: nativeState.source,
      plan: nativeState.plan,
      ceiling,
      epoch: nativeState.epoch,
      nextObject: 57,
      complete: true,
      enabled: true
    })
    expect(await installSnapshotJournalMysqlGeneration(f.k, ceiling)).toEqual(
      await readSnapshotJournalMysqlGeneration(f.k, ceiling)
    )
    expect(f.writes).toEqual([])
  } finally {
    await f.database.destroy()
  }
})
test('lost final object acknowledgement resumes its epoch and advances only the durable intent', async () => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_generation').update({ nextObject: 56, complete: 0 })
    await f.database('snapshot_journal_bootstrap').update({ stream: 0 })
    f.writes.length = 0
    const resumed = await installSnapshotJournalMysqlGeneration(f.k, ceiling)
    expect(resumed).toMatchObject({
      epoch: nativeState.epoch,
      nextObject: 57,
      complete: false,
      enabled: true
    })
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0]).toMatch(/^update `snapshot_journal_generation`/)
  } finally {
    await f.database.destroy()
  }
})
test.each(['sqlite3', 'better-sqlite3', 'pg'])('unsupported driver %s performs no I/O', async client => {
  const f = await fixture()
  try {
    f.k.client.config.client = client
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect(f.raw).not.toHaveBeenCalled()
  } finally {
    await f.database.destroy()
  }
})
test('DDL refuses a caller-owned transaction', async () => {
  const f = await fixture()
  try {
    Object.defineProperty(f.k, 'isTransaction', { value: true })
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect(f.raw).not.toHaveBeenCalled()
  } finally {
    await f.database.destroy()
  }
})
test('generation reads accept the caller pinned view without DDL', async () => {
  const f = await fixture()
  try {
    Object.defineProperty(f.k, 'isTransaction', { value: true })
    expect(await readSnapshotJournalMysqlGeneration(f.k, ceiling)).toMatchObject({
      epoch: nativeState.epoch,
      complete: true,
      enabled: true
    })
    expect(f.writes).toEqual([])
  } finally {
    await f.database.destroy()
  }
})
test('persisted allocator rows cannot establish event continuity', async () => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_events').insert({ revision: '1' })
    await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})
test.each(['0', '01', '9223372036854775808'])('invalid ceiling %s refuses before metadata', async value => {
  const f = await fixture()
  try {
    await expect(installSnapshotJournalMysqlGeneration(f.k, value as typeof ceiling)).rejects.toThrow()
    expect(f.raw).not.toHaveBeenCalled()
  } finally {
    await f.database.destroy()
  }
})
test.each([
  ['TABLE_COMMENT comment', 'engine', 'MyISAM'],
  ['TABLE_COMMENT comment', 'type', 'VIEW'],
  ['TABLE_COMMENT comment', 'collation', 'utf8mb4_general_ci'],
  ['TABLE_COMMENT comment', 'rowFormat', 'Compact'],
  ['TABLE_COMMENT comment', 'options', ''],
  ['TABLE_COMMENT comment', 'comment', 'snapshot-journal-owner:foreign'],
  ['ORDINAL_POSITION LIMIT 9', 'name', 'foreign'],
  ['ORDINAL_POSITION LIMIT 9', 'type', 'bigint'],
  ['ORDINAL_POSITION LIMIT 9', 'nullable', 'YES'],
  ['ORDINAL_POSITION LIMIT 9', 'defaultValue', 0],
  ['ORDINAL_POSITION LIMIT 9', 'extra', 'auto_increment'],
  ['ORDINAL_POSITION LIMIT 9', 'charset', 'utf8mb4'],
  ['ORDINAL_POSITION LIMIT 9', 'collation', 'utf8mb4_bin'],
  ['ORDINAL_POSITION LIMIT 9', 'expression', '1'],
  ['SEQ_IN_INDEX LIMIT 16', 'name', 'foreign'],
  ['SEQ_IN_INDEX LIMIT 16', 'columnName', 'ceiling'],
  ['SEQ_IN_INDEX LIMIT 16', 'position', 2],
  ['SEQ_IN_INDEX LIMIT 16', 'nonUnique', 1],
  ['SEQ_IN_INDEX LIMIT 16', 'direction', 'D'],
  ['SEQ_IN_INDEX LIMIT 16', 'prefix', 1],
  ['SEQ_IN_INDEX LIMIT 16', 'type', 'HASH'],
  ['SEQ_IN_INDEX LIMIT 16', 'visible', 'NO'],
  ['SEQ_IN_INDEX LIMIT 16', 'expression', '1'],
  ['CONSTRAINT_NAME LIMIT 8', 'name', 'foreign'],
  ['CONSTRAINT_NAME LIMIT 8', 'type', 'CHECK'],
  ['CONSTRAINT_NAME LIMIT 8', 'enforced', 'NO'],
  ['CONSTRAINT_NAME LIMIT 8', 'clause', '(`id` = 2)']
])('table metadata %s %s drift refuses before mutation', async (fragment, field, value) => {
  const f = await fixture()
  try {
    f.rows(fragment as string, 'snapshot_journal_clock')[0][field as string] = value
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect(f.writes).toEqual([])
  } finally {
    await f.database.destroy()
  }
})
test.each(['TABLE_COMMENT comment', 'ORDINAL_POSITION LIMIT 9', 'SEQ_IN_INDEX LIMIT 16', 'CONSTRAINT_NAME LIMIT 8'])(
  'missing %s metadata refuses',
  async fragment => {
    const f = await fixture()
    try {
      f.rows(fragment, 'snapshot_journal_clock').pop()
      await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    } finally {
      await f.database.destroy()
    }
  }
)
test.each(['EVENT_OBJECT_TABLE=? LIMIT 1', 'PARTITION_NAME IS NOT NULL LIMIT 1', 'REFERENCED_TABLE_NAME=? LIMIT 1'])(
  'unowned observer/partition/foreign dependency %s refuses',
  async fragment => {
    const f = await fixture()
    try {
      f.rows(fragment, 'snapshot_journal_clock').push({ name: 'foreign' })
      await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    } finally {
      await f.database.destroy()
    }
  }
)
test.each([
  ['name', 'foreign'],
  ['table', 'transactions'],
  ['event', 'DELETE'],
  ['timing', 'BEFORE'],
  ['body', 'BEGIN DO 0; END'],
  ['sqlMode', ''],
  ['charset', 'ascii'],
  ['collation', 'ascii_bin'],
  ['databaseCollation', 'ascii_bin'],
  ['definer', 'foreign@localhost']
])('trigger %s drift refuses exact ownership', async (field, value) => {
  const f = await fixture()
  try {
    f.rows('SUBSTRING(ACTION_STATEMENT,1,?)', 'snapshot_journal_scope_0_INSERT')[0][field] = value
    await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})
test.each(['unknown', 'view', 'missing-prior', 'duplicate', 'future', 'many'])(
  'reserved object %s cannot establish continuity',
  async kind => {
    const f = await fixture()
    try {
      const rows = f.rows('LOWER(LEFT(TABLE_NAME,17))')
      if (kind === 'unknown') rows.push({ name: 'snapshot_journal_foreign', type: 'BASE TABLE' })
      if (kind === 'view') rows.find(row => row.name === 'snapshot_journal_clock')!.type = 'VIEW'
      if (kind === 'missing-prior')
        rows.splice(
          rows.findIndex(row => row.name === 'snapshot_journal_clock'),
          1
        )
      if (kind === 'duplicate') rows.push({ name: 'snapshot_journal_clock', type: 'BASE TABLE' })
      if (kind === 'future') await f.database('snapshot_journal_generation').update({ nextObject: 0, complete: 0 })
      if (kind === 'many')
        rows.push(
          ...Array.from({ length: 130 }, (_, i) => ({
            name: 'snapshot_journal_foreign_' + i,
            type: 'BASE TABLE'
          }))
        )
      f.writes.length = 0
      await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
      expect(f.writes).toEqual([])
    } finally {
      await f.database.destroy()
    }
  }
)
test.each([
  { nextObject: 58 },
  { nextObject: 56 },
  { source: 'a'.repeat(64) },
  { plan: 'a'.repeat(64) },
  { ceiling: '1' }
])('intent drift %j refuses', async patch => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_generation').update(patch)
    await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})
test.each([
  { id: 2 },
  { stream: -1 },
  { stream: 18 },
  { stream: 0.5 },
  { stream: 16 },
  { cursor: '[]' },
  { cursor: 'x'.repeat(2049) }
])('completed bootstrap drift %j refuses', async patch => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_bootstrap').update(patch)
    await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})
test.each(['snapshot_journal_clock', 'snapshot_journal_bootstrap'])(
  'missing %s seed cannot resume or publish',
  async table => {
    const f = await fixture()
    try {
      await f.database(table).delete()
      await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    } finally {
      await f.database.destroy()
    }
  }
)
test.each(['capacity-exhausted', 'revision-exhausted', 'key-out-of-range'])(
  'valid invalidation %s reports disabled while preserving source state',
  async reason => {
    const f = await fixture()
    try {
      await f.database('snapshot_journal_invalid').insert({ id: 1, reason })
      expect(await readSnapshotJournalMysqlGeneration(f.k, ceiling)).toMatchObject({
        complete: true,
        enabled: false
      })
    } finally {
      await f.database.destroy()
    }
  }
)
test.each([
  { id: 2, reason: 'capacity-exhausted' },
  { id: 1, reason: 'unknown' }
])('malformed invalidation %j refuses', async row => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_invalid').insert(row)
    await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})

const objectNames = nativeDdl.ddl.map(
  entry => /^CREATE (?:TABLE|TRIGGER) (snapshot_journal_[A-Za-z0-9_]+)/.exec(entry.sql)![1]
)
test('fresh installation uses the independently captured native DDL and atomically seeded controls', async () => {
  const f = await fixture()
  try {
    await f.fresh()
    const state = await installSnapshotJournalMysqlGeneration(f.k, ceiling)
    expect(state).toMatchObject({ nextObject: 57, complete: false, enabled: true })
    expect(state.epoch).not.toBe(nativeState.epoch)
    expect(await f.database('snapshot_journal_clock')).toEqual([{ id: 1, ceiling }])
    expect(await f.database('snapshot_journal_bootstrap')).toEqual([{ id: 1, stream: 0, cursor: null }])
    expect(objectNames).toHaveLength(58)
  } finally {
    await f.database.destroy()
  }
})
test.each(objectNames)('every DDL acknowledgement loss resumes without adopting/replacing %s', async name => {
  const f = await fixture()
  try {
    await f.fresh()
    f.fault.phase = 'after:' + name
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('lost reply')
    const before = await f.database('snapshot_journal_generation').first()
    const resumed = await installSnapshotJournalMysqlGeneration(f.k, ceiling)
    expect(f.fault.fired).toBe(true)
    expect(resumed).toMatchObject({
      epoch: before.epoch,
      nextObject: 57,
      complete: false,
      enabled: true
    })
    expect(
      f.raw.mock.calls.filter(
        ([sql]) => /^CREATE (?:TABLE|TRIGGER) (snapshot_journal_[A-Za-z0-9_]+)/.exec(sql)?.[1] === name
      )
    ).toHaveLength(1)
  } finally {
    await f.database.destroy()
  }
})
test.each([0, 1, 5, 6, 57])('before DDL boundary %i creates no undocumented object', async index => {
  const f = await fixture()
  try {
    await f.fresh()
    f.fault.phase = 'before:' + objectNames[index]
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('lost reply')
    expect(await installSnapshotJournalMysqlGeneration(f.k, ceiling)).toMatchObject({
      nextObject: 57,
      complete: false,
      enabled: true
    })
  } finally {
    await f.database.destroy()
  }
})
test.each([1, 6, 7, 57])('lost progress acknowledgement %i resumes committed state', async position => {
  const f = await fixture()
  try {
    await f.fresh()
    f.fault.phase = 'ack:' + position
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('lost reply')
    expect((await f.database('snapshot_journal_generation').first()).nextObject).toBe(position)
    expect(await installSnapshotJournalMysqlGeneration(f.k, ceiling)).toMatchObject({
      nextObject: 57,
      complete: false,
      enabled: true
    })
  } finally {
    await f.database.destroy()
  }
})
test('completion commits once and can be read in the same retained generation', async () => {
  const f = await fixture()
  try {
    expect(await completeSnapshotJournalMysqlGeneration(f.k, ceiling)).toMatchObject({
      epoch: nativeState.epoch,
      nextObject: 57,
      complete: true,
      enabled: true
    })
    expect((await f.database('snapshot_journal_generation').first()).complete).toBe(1)
  } finally {
    await f.database.destroy()
  }
})
test.each(['complete:before', 'complete:after'])(
  'completion %s loss rolls back its durable publication',
  async phase => {
    const f = await fixture()
    try {
      await f.database('snapshot_journal_generation').update({ complete: 0 })
      f.fault.phase = phase
      await expect(completeSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('lost reply')
      expect((await f.database('snapshot_journal_generation').first()).complete).toBe(0)
      expect(await completeSnapshotJournalMysqlGeneration(f.k, ceiling)).toMatchObject({
        complete: true,
        enabled: true
      })
    } finally {
      await f.database.destroy()
    }
  }
)
test.each(['incomplete', 'invalidated'])('completion refuses %s progress without publication', async kind => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_generation').update({ complete: 0 })
    if (kind === 'incomplete') await f.database('snapshot_journal_bootstrap').update({ stream: 16 })
    else await f.database('snapshot_journal_invalid').insert({ id: 1, reason: 'capacity-exhausted' })
    await expect(completeSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect((await f.database('snapshot_journal_generation').first()).complete).toBe(0)
  } finally {
    await f.database.destroy()
  }
})

// Context is part of persisted trigger ownership and the plan digest. A malformed
// driver response must not establish a weaker ownership contract.
test.each(['missing row', 'extra row', 'missing field', 'extra field', 'numeric field', 'oversized field'])(
  'installation rejects malformed native context: %s',
  async kind => {
    const f = await fixture()
    try {
      const rows = f.rows('SELECT @@sql_mode')
      if (kind === 'missing row') rows.length = 0
      if (kind === 'extra row') rows.push({ ...rows[0] })
      if (kind === 'missing field') delete rows[0].definer
      if (kind === 'extra field') rows[0].unexpected = 'unknown'
      if (kind === 'numeric field') rows[0].charset = 1
      if (kind === 'oversized field') rows[0].sqlMode = 'x'.repeat(4097)
      await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
      expect(f.writes).toEqual([])
    } finally {
      await f.database.destroy()
    }
  }
)
test.each(['malformed trigger', 'missing trigger', 'duplicate trigger'])(
  'installation rejects an inconsistent generated plan: %s',
  async kind => {
    const f = await fixture()
    let spy: jest.SpyInstance | undefined
    try {
      const definitions = await observers.snapshotJournalMysqlObserverSql(f.k)
      if (kind === 'malformed trigger') definitions[0] = 'CREATE TABLE unrelated(id INT)'
      if (kind === 'missing trigger') definitions.pop()
      if (kind === 'duplicate trigger') definitions[1] = definitions[0]
      spy = jest.spyOn(observers, 'snapshotJournalMysqlObserverSql').mockResolvedValue(definitions)
      await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
      expect(f.writes).toEqual([])
    } finally {
      spy?.mockRestore()
      await f.database.destroy()
    }
  }
)
test('zero journal capacity refuses before metadata reads or writes', async () => {
  const f = await fixture()
  try {
    await expect(installSnapshotJournalMysqlGeneration(f.k, snapshotJournalRevision('0'))).rejects.toThrow(
      'Invalid or unowned'
    )
    expect(f.raw).not.toHaveBeenCalled()
    expect(f.writes).toEqual([])
  } finally {
    await f.database.destroy()
  }
})

test('installation refuses a changed source binding before returning generation ownership', async () => {
  const f = await fixture()
  try {
    readBinding.mockResolvedValueOnce(String(nativeState.source)).mockResolvedValueOnce('f'.repeat(64))
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect(f.writes).toEqual([])
  } finally {
    await f.database.destroy()
  }
})
test('lost update ownership cannot acknowledge an installation object', async () => {
  const f = await fixture()
  try {
    await f.fresh()
    f.fault.zeroNext = true
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect((await f.database('snapshot_journal_generation').first()).nextObject).toBe(0)
    f.fault.zeroNext = false
    expect(await installSnapshotJournalMysqlGeneration(f.k, ceiling)).toMatchObject({
      nextObject: 57,
      complete: false
    })
  } finally {
    await f.database.destroy()
  }
})
test('lost update ownership cannot publish completion', async () => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_generation').update({ complete: 0 })
    f.fault.zeroComplete = true
    await expect(completeSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect((await f.database('snapshot_journal_generation').first()).complete).toBe(0)
  } finally {
    await f.database.destroy()
  }
})
test.each(['clock missing', 'epoch changed', 'progress changed', 'bootstrap missing', 'invalidated'])(
  'publication revalidates transaction-owned %s and rolls back refusal',
  async kind => {
    const f = await fixture()
    try {
      await f.database('snapshot_journal_generation').update({ complete: 0 })
      f.fault.beforeTransaction = async t => {
        if (kind === 'clock missing') await t('snapshot_journal_clock').delete()
        if (kind === 'epoch changed')
          await t('snapshot_journal_generation').update({
            epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          })
        if (kind === 'progress changed') await t('snapshot_journal_generation').update({ nextObject: 56 })
        if (kind === 'bootstrap missing') await t('snapshot_journal_bootstrap').delete()
        if (kind === 'invalidated') await t('snapshot_journal_invalid').insert({ id: 1, reason: 'capacity-exhausted' })
      }
      await expect(completeSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
      expect((await f.database('snapshot_journal_generation').first()).complete).toBe(0)
      expect(await f.database('snapshot_journal_clock')).toEqual([{ id: 1, ceiling }])
      expect(await f.database('snapshot_journal_invalid')).toEqual([])
    } finally {
      await f.database.destroy()
    }
  }
)
test('installation refuses a partial bootstrap cursor before resuming DDL', async () => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_generation').update({ nextObject: 56, complete: 0 })
    await f.database('snapshot_journal_bootstrap').update({ stream: 1 })
    f.writes.length = 0
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect(f.writes).toEqual([])
  } finally {
    await f.database.destroy()
  }
})
test.each([58, 56])('installation refuses invalid complete next-object position %i', async nextObject => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_generation').update({ nextObject })
    f.writes.length = 0
    await expect(installSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect(f.writes).toEqual([])
  } finally {
    await f.database.destroy()
  }
})
test('generation requires its intent in the reserved-object inventory', async () => {
  const f = await fixture()
  try {
    const rows = f.rows('LOWER(LEFT(TABLE_NAME,17))')
    rows.splice(
      rows.findIndex(row => row.name === 'snapshot_journal_generation'),
      1
    )
    await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect(f.writes).toEqual([])
  } finally {
    await f.database.destroy()
  }
})

test('final state rechecks a clock response after object validation', async () => {
  const f = await fixture()
  let reads = 0
  const listener = (rows: unknown[], query: { sql: string }) => {
    if (query.sql.startsWith('select `id`, CAST(ceiling AS CHAR) ceiling from `snapshot_journal_clock`')) {
      reads++
      if (reads === 2) rows.splice(0)
    }
  }
  f.database.on('query-response', listener)
  try {
    await expect(readSnapshotJournalMysqlGeneration(f.k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect(reads).toBe(2)
  } finally {
    f.database.off('query-response', listener)
    await f.database.destroy()
  }
})
