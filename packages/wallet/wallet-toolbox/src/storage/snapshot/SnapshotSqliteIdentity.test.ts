import { copyIdentityPage } from '../../../test/utils/snapshotSqliteIdentityFixture'
import { knex, type Knex } from 'knex'
import fc from 'fast-check'
import {
  readIdentity,
  identityDDL,
  observeIdentity,
  displacedIdentity,
  finishIdentity,
  type SourceIdentity,
  type IdentityDefinition
} from '../schema/snapshotSqliteIdentity'

const sources: Array<
  SourceIdentity & {
    fields: string
    unique: string[]
    values: (id: number) => Record<string, unknown>
  }
> = [
  {
    table: 'transactions',
    key: 'transactionId',
    owner: 'userId',
    fields: 'reference varchar(64)',
    unique: ['reference'],
    values: id => ({ reference: 'r' + id })
  },
  {
    table: 'proven_txs',
    key: 'provenTxId',
    fields: 'txid varchar(64)',
    unique: ['txid'],
    values: id => ({ txid: 't' + id })
  },
  {
    table: 'proven_tx_reqs',
    key: 'provenTxReqId',
    fields: 'txid varchar(64)',
    unique: ['txid'],
    values: id => ({ txid: 't' + id })
  },
  {
    table: 'outputs',
    key: 'outputId',
    owner: 'userId',
    fields: 'transactionId integer, vout integer',
    unique: ['transactionId,vout,userId'],
    values: id => ({ transactionId: 1, vout: id })
  },
  {
    table: 'certificates',
    key: 'certificateId',
    owner: 'userId',
    fields: 'type varchar(100), certifier varchar(130), serialNumber varchar(100)',
    unique: ['userId,type,certifier,serialNumber'],
    values: id => ({ type: 'a', certifier: 'b', serialNumber: 's' + id })
  },
  {
    table: 'tx_labels',
    key: 'txLabelId',
    owner: 'userId',
    fields: 'label varchar(300)',
    unique: ['label,userId'],
    values: id => ({ label: 'l' + id })
  },
  {
    table: 'output_tags',
    key: 'outputTagId',
    owner: 'userId',
    fields: 'tag varchar(150)',
    unique: ['tag,userId'],
    values: id => ({ tag: 't' + id })
  },
  {
    table: 'output_baskets',
    key: 'basketId',
    owner: 'userId',
    fields: 'name varchar(300)',
    unique: ['name,userId'],
    values: id => ({ name: 'b' + id })
  },
  {
    table: 'commissions',
    key: 'commissionId',
    owner: 'userId',
    fields: 'transactionId integer',
    unique: ['transactionId'],
    values: id => ({ transactionId: id })
  },
  {
    table: 'sync_states',
    key: 'syncStateId',
    owner: 'userId',
    fields: 'refNum varchar(100)',
    unique: ['refNum'],
    values: id => ({ refNum: 'r' + id })
  }
]

async function database(source: (typeof sources)[number], collation: string, recursive: boolean) {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  await k.raw('PRAGMA recursive_triggers=' + Number(recursive))
  const fields = source.fields.replaceAll(/varchar\(\d+\)/g, value => value + ' COLLATE ' + collation)
  await k.raw(
    `CREATE TABLE ${source.table}(${source.key} integer PRIMARY KEY${source.owner ? ',userId integer NOT NULL' : ''},${fields},${source.unique.map(value => 'UNIQUE(' + value + ')').join(',')})`
  )
  const definition = await readIdentity(k, source)
  for (const ddl of identityDDL(definition)) await k.raw(ddl)
  await k.raw('CREATE TABLE observed(id integer,userId integer)')
  return { k, definition }
}

async function observers(k: Knex, d: IdentityDefinition) {
  for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    if (event !== 'DELETE') {
      await k.raw(
        `CREATE TRIGGER witness_before_${event} BEFORE ${event} ON ${d.source.table} BEGIN ${observeIdentity(d, event === 'UPDATE')} END`
      )
    }
    const observed =
      event === 'DELETE'
        ? `INSERT INTO observed VALUES(OLD.${d.source.key},${d.source.owner ? 'OLD.' + d.source.owner : 'NULL'});`
        : `INSERT INTO observed SELECT ${d.source.key},${d.source.owner ?? 'NULL'} FROM (${displacedIdentity(d, event === 'UPDATE')});`
    await k.raw(
      `CREATE TRIGGER witness_after_${event} AFTER ${event} ON ${d.source.table} BEGIN ${observed} ${finishIdentity(d, event)} END`
    )
  }
}

function row(source: (typeof sources)[number], id: number, owner = 1, unique = id) {
  return { [source.key]: id, ...(source.owner ? { userId: owner } : {}), ...source.values(unique) }
}

async function same(k: Knex, d: IdentityDefinition) {
  const columns = d.columns.map(column => column.name)
  expect(await k(d.table).select(columns).orderBy(d.source.key)).toEqual(
    await k(d.source.table).select(columns).orderBy(d.source.key)
  )
}

async function copy(k: Knex, d: IdentityDefinition) {
  let after: number | undefined = 0
  do {
    const current: number = after
    after = await k.transaction(trx => copyIdentityPage(trx, d, current, 1))
  } while (after !== undefined)
}

test.each(sources)('captures unbootstrapped primary and unique conflicts in $table', async source => {
  for (const collation of ['BINARY', 'NOCASE', 'RTRIM'])
    for (const recursive of [false, true]) {
      const { k, definition: d } = await database(source, collation, recursive)
      try {
        await k(source.table).insert([row(source, 1), row(source, 2), row(source, 3)])
        await observers(k, d)
        const replacement = row(source, 1, 1, 2)
        const insert = k(source.table).insert(replacement).toSQL()
        await k.raw(insert.sql.replace(/^insert/i, 'INSERT OR REPLACE'), insert.bindings)
        expect(await k('observed').orderBy('id')).toEqual([1, 2].map(id => ({ id, userId: source.owner ? 1 : null })))
        await copy(k, d)
        await same(k, d)
        await k('observed').delete()
        const update = k(source.table)
          .where(source.key, 3)
          .update({ [source.key]: 1 })
          .toSQL()
        await k.raw(update.sql.replace(/^update/i, 'UPDATE OR IGNORE'), update.bindings)
        expect(await k('observed')).toEqual([])
        await same(k, d)
      } finally {
        await k.destroy()
      }
    }
})

test.each(['BINARY', 'NOCASE', 'RTRIM'])(
  'identity schedules match source state under %s',
  async collation => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: sources.length - 1 }),
        fc.boolean(),
        fc.array(
          fc.record({
            kind: fc.integer({ min: 0, max: 5 }),
            id: fc.integer({ min: 1, max: 6 }),
            other: fc.integer({ min: 1, max: 6 }),
            owner: fc.integer({ min: 1, max: 3 })
          }),
          { minLength: 1, maxLength: 25 }
        ),
        async (index, recursive, operations) => {
          const source = sources[index]
          const { k, definition: d } = await database(source, collation, recursive)
          try {
            await observers(k, d)
            for (const op of operations) {
              const value = row(source, op.id, op.owner, op.other)
              if (op.kind < 2) {
                const query = k(source.table).insert(value).toSQL()
                await k.raw(
                  query.sql.replace(/^insert/i, op.kind === 0 ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'),
                  query.bindings
                )
              } else if (op.kind < 4) {
                const query = k(source.table)
                  .where(source.key, op.id)
                  .update(row(source, op.other, op.owner, op.id))
                  .toSQL()
                await k.raw(
                  query.sql.replace(/^update/i, op.kind === 2 ? 'UPDATE OR REPLACE' : 'UPDATE OR IGNORE'),
                  query.bindings
                )
              } else if (op.kind === 4) {
                await k(source.table).where(source.key, op.id).delete()
              } else {
                await k.transaction(async trx => {
                  await trx(source.table).where(source.key, op.id).delete()
                  await trx.rollback()
                })
              }
              await same(k, d)
            }
          } finally {
            await k.destroy()
          }
        }
      ),
      { numRuns: 300, seed: 3242026 }
    )
  },
  30000
)

test('nullable unique values do not identify unrelated rows', async () => {
  const source = sources[0]
  const { k, definition: d } = await database(source, 'BINARY', false)
  try {
    await observers(k, d)
    await k(source.table).insert([
      { transactionId: 1, userId: 1, reference: null },
      { transactionId: 2, userId: 2, reference: null }
    ])
    await same(k, d)
    expect(await k('observed')).toEqual([])
  } finally {
    await k.destroy()
  }
})

test.each([
  ['BINARY', 'A', false],
  ['NOCASE', 'A', true],
  ['RTRIM', 'a ', true]
] as const)('unique comparison preserves exact spelling under %s', async (collation, spelling, displaced) => {
  const { k, definition: d } = await database(sources[0], collation, false)
  try {
    await k('transactions').insert({ transactionId: 1, userId: 1, reference: 'a' })
    await observers(k, d)
    await k.raw('INSERT OR REPLACE INTO transactions(transactionId,userId,reference) VALUES(2,2,?)', [spelling])
    expect(await k('observed')).toEqual(displaced ? [{ id: 1, userId: 1 }] : [])
    await copy(k, d)
    await same(k, d)
    expect((await k(d.table).where('transactionId', 2).first()).reference).toBe(spelling)
  } finally {
    await k.destroy()
  }
})

test('bootstrap refuses a caller without a transaction before copying rows', async () => {
  const { k, definition: d } = await database(sources[0], 'BINARY', false)
  try {
    await k('transactions').insert(row(sources[0], 1))
    await expect(copyIdentityPage(k, d, 0)).rejects.toThrow('requires a transaction')
    expect(await k(d.table)).toEqual([])
  } finally {
    await k.destroy()
  }
})

test.each([false, true])('nested ownership changes retain every displaced owner, recursive=%s', async recursive => {
  for (const registerNestedFirst of [false, true]) {
    const { k, definition: d } = await database(sources[0], 'BINARY', recursive)
    try {
      await k('transactions').insert(row(sources[0], 1, 1))
      const nested = () =>
        k.raw(
          'CREATE TRIGGER nested_owner AFTER INSERT ON transactions WHEN NEW.userId=2 BEGIN UPDATE transactions SET userId=3 WHERE transactionId=NEW.transactionId; END'
        )
      if (registerNestedFirst) await nested()
      await observers(k, d)
      if (!registerNestedFirst) await nested()
      await k.raw('INSERT OR REPLACE INTO transactions(transactionId,userId,reference) VALUES(1,2,?)', ['r1'])
      expect(await k('observed')).toEqual(
        expect.arrayContaining([
          { id: 1, userId: 1 },
          { id: 1, userId: 2 }
        ])
      )
      await same(k, d)
      expect((await k('transactions').first()).userId).toBe(3)
    } finally {
      await k.destroy()
    }
  }
})

function openIdentitySchema() {
  return knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
}

test.each([
  'id INTEGER,owner INTEGER,label VARCHAR(100)',
  'id INTEGER,owner INTEGER,label VARCHAR(100),PRIMARY KEY(id,owner)',
  'id INTEGER,owner INTEGER PRIMARY KEY,label VARCHAR(100)',
  'id BIGINT PRIMARY KEY,owner INTEGER,label VARCHAR(100)'
])('unsupported native numeric identity refuses before creating witnesses: %s', async columns => {
  const k = openIdentitySchema()
  try {
    await k.raw(`CREATE TABLE candidate_identity(${columns})`)
    await expect(readIdentity(k, { table: 'candidate_identity', key: 'id', owner: 'owner' })).rejects.toThrow(
      'Unsupported numeric identity'
    )
    expect(await k.schema.hasTable('snapshot_identity_candidate_identity')).toBe(false)
  } finally {
    await k.destroy()
  }
})

test('partial unique constraints cannot establish complete conflict witnesses', async () => {
  const k = openIdentitySchema()
  try {
    await k.raw('CREATE TABLE candidate_identity(id INTEGER PRIMARY KEY,owner INTEGER,label VARCHAR(100))')
    await k.raw('CREATE UNIQUE INDEX conditional_identity ON candidate_identity(label) WHERE owner=1')
    await expect(readIdentity(k, { table: 'candidate_identity', key: 'id', owner: 'owner' })).rejects.toThrow(
      'Unsupported partial unique identity'
    )
  } finally {
    await k.destroy()
  }
})

test('mixed expression and column unique keys refuse unsupported comparison semantics', async () => {
  const k = openIdentitySchema()
  try {
    await k.raw('CREATE TABLE candidate_identity(id INTEGER PRIMARY KEY,owner INTEGER,label VARCHAR(100))')
    await k.raw('CREATE UNIQUE INDEX expression_identity ON candidate_identity(owner,LOWER(label))')
    await expect(readIdentity(k, { table: 'candidate_identity', key: 'id', owner: 'owner' })).rejects.toThrow(
      'Unsupported unique identity comparison'
    )
  } finally {
    await k.destroy()
  }
})

test.each([
  'label TEXT',
  'label BLOB',
  'label REAL',
  'label VARCHAR(0)',
  'label UNSIGNED BIGINT',
  'label INTEGER UNSIGNED',
  'label VARCHAR(100) GENERATED ALWAYS AS (CAST(id AS TEXT)) VIRTUAL',
  'label VARCHAR(100) GENERATED ALWAYS AS (CAST(id AS TEXT)) STORED'
])('unsupported or generated unique column refuses witness adoption: %s', async column => {
  const k = openIdentitySchema()
  try {
    await k.raw(`CREATE TABLE candidate_identity(id INTEGER PRIMARY KEY,owner INTEGER,${column},UNIQUE(label))`)
    await expect(readIdentity(k, { table: 'candidate_identity', key: 'id', owner: 'owner' })).rejects.toThrow(
      'Unsupported identity column'
    )
  } finally {
    await k.destroy()
  }
})

test('a missing ownership column refuses metadata adoption with its stable error', async () => {
  const k = openIdentitySchema()
  try {
    await k.raw('CREATE TABLE candidate_identity(id INTEGER PRIMARY KEY,label VARCHAR(100) UNIQUE)')
    await expect(readIdentity(k, { table: 'candidate_identity', key: 'id', owner: 'owner' })).rejects.toThrow(
      'Unsupported identity column'
    )
  } finally {
    await k.destroy()
  }
})

test('witness primary components are explicitly non-nullable', async () => {
  const k = openIdentitySchema()
  try {
    await k.raw('CREATE TABLE candidate_identity(id INTEGER PRIMARY KEY,owner INTEGER,label VARCHAR(100) UNIQUE)')
    const identity = await readIdentity(k, { table: 'candidate_identity', key: 'id', owner: 'owner' })
    for (const sql of identityDDL(identity)) await k.raw(sql)
    const columns: Array<{ name: string; notnull: number }> = await k.raw('PRAGMA table_info(??)', [identity.table])
    expect(columns.map(column => ({ name: column.name, notnull: column.notnull }))).toEqual([
      { name: 'id', notnull: 1 },
      { name: 'owner', notnull: 1 },
      { name: 'label', notnull: 0 }
    ])
    await expect(k(identity.table).insert({ id: 1, owner: null, label: 'a' })).rejects.toThrow('NOT NULL')
    await expect(k(identity.table).insert({ id: null, owner: 1, label: 'a' })).rejects.toThrow('NOT NULL')
  } finally {
    await k.destroy()
  }
})

test('quoted native identifiers retain exact ownership and conflict comparison', async () => {
  const k = openIdentitySchema()
  const table = 'records"archive',
    key = 'numeric"id',
    owner = 'owner"id',
    label = 'exact"label'
  try {
    await k.raw('CREATE TABLE ??(?? INTEGER PRIMARY KEY,?? INTEGER,?? VARCHAR(100) COLLATE NOCASE UNIQUE)', [
      table,
      key,
      owner,
      label
    ])
    const identity = await readIdentity(k, { table, key, owner })
    for (const sql of identityDDL(identity)) await k.raw(sql)
    await k.raw(`CREATE TRIGGER quoted_before BEFORE INSERT ON ?? BEGIN ${observeIdentity(identity, false)} END`, [
      table
    ])
    await k.raw(`CREATE TRIGGER quoted_after AFTER INSERT ON ?? BEGIN ${finishIdentity(identity, 'INSERT')} END`, [
      table
    ])
    await k(table).insert({ [key]: 1, [owner]: 1, [label]: 'A' })
    const query = k(table)
      .insert({ [key]: 2, [owner]: 2, [label]: 'a' })
      .toSQL()
    await k.raw(query.sql.replace(/^insert/i, 'INSERT OR REPLACE'), query.bindings)
    expect(await k(identity.table)).toEqual([{ [key]: 2, [owner]: 2, [label]: 'a' }])
    expect(await k(table)).toEqual(await k(identity.table))
  } finally {
    await k.destroy()
  }
})

test.each(['no key parts', 'unknown collation'])(
  'unexpected driver index metadata refuses before adoption: %s',
  async kind => {
    const k = openIdentitySchema()
    const client = Object.getPrototypeOf(k.client) as { processResponse: (...args: unknown[]) => unknown }
    const original = client.processResponse
    let response: ReturnType<typeof jest.spyOn> | undefined
    try {
      await k.raw(
        'CREATE TABLE candidate_identity(id INTEGER PRIMARY KEY,owner INTEGER,label VARCHAR(100),UNIQUE(owner,label))'
      )
      let injected = 0
      response = jest.spyOn(client, 'processResponse').mockImplementation(function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args)
        const query = args[0]
        if (
          typeof query === 'object' &&
          query !== null &&
          'sql' in query &&
          typeof query.sql === 'string' &&
          query.sql.startsWith('PRAGMA index_xinfo(')
        ) {
          const parts = result as Array<{ name: string | null; key: number; coll: string }>
          expect(parts.filter(part => part.key !== 0).map(part => part.name)).toEqual(['owner', 'label'])
          injected++
          return kind === 'no key parts'
            ? parts.filter(part => part.key === 0)
            : parts.map(part => (part.name === 'label' ? { ...part, coll: 'UNSUPPORTED_COLLATION' } : part))
        }
        return result
      })
      await expect(readIdentity(k, { table: 'candidate_identity', key: 'id', owner: 'owner' })).rejects.toThrow(
        'Unsupported unique identity comparison'
      )
      expect(injected).toBe(1)
      response.mockRestore()
      response = undefined
      expect((await readIdentity(k, { table: 'candidate_identity', key: 'id', owner: 'owner' })).unique).toEqual([
        [
          { name: 'owner', collation: 'BINARY' },
          { name: 'label', collation: 'BINARY' }
        ]
      ])
    } finally {
      response?.mockRestore()
      await k.destroy()
    }
  }
)
