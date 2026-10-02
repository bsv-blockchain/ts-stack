import { readGenerationIndexState, migration } from '../schema/snapshotSqliteIndexState'
import { dropGenerationForDataDeletion } from '../schema/snapshotSqliteIndexMigration'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { Knex } from 'knex'
import { fixture, exact, value, replace, tables } from '../../../test/utils/snapshotSqliteFixtures'
import {
  installGeneration,
  readPlan,
  validateInstalled,
  names,
  metadata,
  progress,
  oldProgress
} from '../schema/snapshotSqliteIndexGeneration'
import { copyGenerationPage } from '../schema/snapshotSqliteIndexBootstrap'
import { legacyNames } from '../schema/snapshotSqliteMembership'
import { retiredTables } from '../schema/snapshotSqliteLegacyOwnership'
import { knex } from 'knex'

function generation(k: Knex): Knex {
  const mapping = new Map(Object.entries(legacyNames).map(([key, value]) => [value, names[key as keyof typeof names]]))
  return new Proxy(k, {
    apply(target, self, args: unknown[]) {
      if (typeof args[0] === 'string' && mapping.has(args[0])) args[0] = mapping.get(args[0])
      return Reflect.apply(target, self, args)
    }
  })
}
async function finish(k: Knex, plan: Awaited<ReturnType<typeof installGeneration>>) {
  for (let page = 0; page < 100; page++) if ((await copyGenerationPage(k, plan)).complete) return
  throw new Error('Rebuild did not finish')
}

test.each(['BINARY', 'NOCASE', 'RTRIM'])(
  'fresh %s generation repairs stale indexes while low-key writes continue',
  async collation => {
    const k = await fixture(collation, false, false)
    try {
      for (const table of tables) for (const id of [1, 2]) await k(table).insert(value(table, id, id, id))
      await replace(k, 'transactions', value('transactions', 1, 2, 3))
      await expect(exact(k)).rejects.toThrow()
      const source = await k('transactions')
      const plan = await installGeneration(k)
      expect(await k('transactions')).toEqual(source)
      for (const table of oldProgress) expect((await k(table)).every(row => row.complete === 0)).toBe(true)
      let pages = 0
      for (; pages < 100; pages++) {
        const result = await copyGenerationPage(k, plan)
        if (result.complete) break
        await replace(k, 'transactions', value('transactions', 1, 2, (pages % 2) + 1))
        await replace(k, 'certificates', value('certificates', 1, 1, (pages % 2) + 1))
        await replace(k, 'proven_tx_reqs', value('proven_tx_reqs', 1, 2, (pages % 2) + 1))
      }
      expect(pages).toBe(12)
      await exact(generation(k))
      expect(await k(metadata).first('complete')).toEqual({ complete: 1 })
      expect(await installGeneration(k)).toEqual(plan)
      await finish(k, plan)
      await exact(generation(k))
    } finally {
      await k.destroy()
    }
  }
)

test('page rollback keeps its cursor and memberships together; resumed copies are bounded', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    for (let start = 0; start < 600; start += 100)
      await k('transactions').insert(
        Array.from({ length: 100 }, (_, i) => value('transactions', start + i + 1, start + i + 1, 1))
      )
    const plan = await installGeneration(k)
    const failure = new Error('synthetic checkpoint write failure')
    const inject = (query: { sql: string }) => {
      if (query.sql.startsWith('update `' + progress + '`')) throw failure
    }
    k.on('query', inject)
    try {
      await expect(copyGenerationPage(k, plan)).rejects.toBe(failure)
    } finally {
      k.off('query', inject)
    }
    expect(await k(names.profile)).toEqual([])
    expect(await k(progress).where('stream', 0).first()).toMatchObject({ afterId: 0, complete: 0 })
    const first = await copyGenerationPage(k, plan)
    expect(first.copiedThrough).toMatchObject({ afterId: 256, complete: 0 })
    expect(await k(names.profile)).toHaveLength(256)
    await replace(k, 'transactions', value('transactions', 1, 2, 2))
    const resumed = await installGeneration(k)
    expect((await copyGenerationPage(k, resumed)).copiedThrough).toMatchObject({
      afterId: 512,
      complete: 0
    })
    expect((await copyGenerationPage(k, resumed)).copiedThrough).toMatchObject({
      afterId: 600,
      complete: 1
    })
    await finish(k, resumed)
    await exact(generation(k))
  } finally {
    await k.destroy()
  }
})

test.each([
  ['tx_labels_map', 'txLabelId INTEGER,transactionId INTEGER,UNIQUE(transactionId,txLabelId)'],
  ['tx_labels_map', 'txLabelId INTEGER,transactionId INTEGER,UNIQUE(txLabelId)'],
  ['tx_labels_map', 'txLabelId INTEGER,transactionId INTEGER,UNIQUE(txLabelId DESC,transactionId)'],
  ['tx_labels_map', 'txLabelId INTEGER,transactionId INTEGER,UNIQUE(txLabelId COLLATE NOCASE,transactionId)'],
  ['tx_labels_map', 'txLabelId INTEGER,transactionId INTEGER,UNIQUE(txLabelId,transactionId COLLATE RTRIM)'],
  [
    'certificate_fields',
    'userId INTEGER,fieldName VARCHAR(100),certificateId INTEGER,fieldValue TEXT,UNIQUE(fieldName,certificateId COLLATE NOCASE)'
  ]
])('unsupported native composite comparison refuses before writing: %s / %s', async (table, columns) => {
  const k = await fixture('BINARY', false, false)
  try {
    await k.schema.dropTable(table)
    await k.raw(`CREATE TABLE ?? (${columns})`, [table])
    const before = await k('sqlite_master').orderBy(['type', 'name'])
    await expect(installGeneration(k)).rejects.toThrow('Unsupported composite identity comparison')
    expect(await k('sqlite_master').orderBy(['type', 'name'])).toEqual(before)
  } finally {
    await k.destroy()
  }
})

test('an index whose comparison differs from the source order refuses a sorting scan', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k.schema.dropTable('certificate_fields')
    await k.raw(
      'CREATE TABLE certificate_fields(userId INTEGER,fieldName VARCHAR(100),certificateId INTEGER,fieldValue TEXT,UNIQUE(fieldName COLLATE NOCASE,certificateId))'
    )
    const query = 'SELECT fieldName,certificateId FROM certificate_fields ORDER BY fieldName,certificateId LIMIT 1'
    expect(
      (await k.raw('EXPLAIN QUERY PLAN ' + query)).some((step: { detail: string }) =>
        step.detail.includes('TEMP B-TREE')
      )
    ).toBe(true)
    await expect(installGeneration(k)).rejects.toThrow('Composite source order mismatch')
    expect(await k.schema.hasTable(metadata)).toBe(false)
  } finally {
    await k.destroy()
  }
})

test('the SQLite generation refuses a different database client before issuing queries', async () => {
  const k = knex({ client: 'mysql2' })
  const query = jest.fn()
  k.on('query', query)
  try {
    await expect(readPlan(k)).rejects.toThrow('SQLite rebuild requires SQLite')
    expect(query).not.toHaveBeenCalled()
  } finally {
    await k.destroy()
  }
})

test('validation binds the observed source schema and rejects malformed generated definitions', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    const plan = await installGeneration(k)
    await k.raw('CREATE INDEX extra_source_index ON tx_labels(userId)')
    await expect(validateInstalled(k, plan)).rejects.toThrow('Rebuild source schema changed')
    await k.raw('DROP INDEX extra_source_index')
    await expect(validateInstalled(k, { ...plan, ddl: ['SELECT 1'] })).rejects.toThrow(
      'Invalid generated schema definition'
    )
    await expect(validateInstalled(k, plan)).resolves.toBeUndefined()
  } finally {
    await k.destroy()
  }
})

test.each(['absent', 'extra', 'wrong id', 'invalid complete', 'binary legacy'])(
  'generation metadata must be one correctly typed source-bound row: %s',
  async kind => {
    const k = await fixture('BINARY', false, false)
    try {
      const plan = await installGeneration(k)
      if (kind === 'absent') await k(metadata).delete()
      if (kind === 'extra') await k(metadata).insert({ ...(await k(metadata).first()), id: 1 })
      if (kind === 'wrong id') await k(metadata).update({ id: 1 })
      if (kind === 'invalid complete') await k(metadata).update({ complete: 2 })
      if (kind === 'binary legacy') await k.raw('UPDATE ?? SET legacy = ?', [metadata, Buffer.from([0])])
      await expect(validateInstalled(k, plan)).rejects.toThrow('Rebuild source binding mismatch')
    } finally {
      await k.destroy()
    }
  }
)

test.each(oldProgress)('an incomplete prior index refuses replacement: %s', async table => {
  const k = await fixture('BINARY', false, false)
  try {
    await k(table).update({ complete: false })
    await k('knex_migrations')
      .where('name', 'like', `% snapshot ${table.split('_')[1]} %`)
      .delete()
    const before = await k('sqlite_master').orderBy(['type', 'name'])
    await expect(installGeneration(k)).rejects.toThrow('Prior snapshot migrations must be complete')
    expect(await k('sqlite_master').orderBy(['type', 'name'])).toEqual(before)
  } finally {
    await k.destroy()
  }
})

test.each(retiredTables)('foreign views of %s prevent retiring their data', async table => {
  const k = await fixture('BINARY', false, false)
  try {
    await k.raw('CREATE VIEW foreign_snapshot_reader AS SELECT * FROM ??', [table.toUpperCase()])
    await expect(installGeneration(k)).rejects.toThrow('Unowned object references legacy auxiliary data')
    expect(await k.schema.hasTable(metadata)).toBe(false)
    expect(await k.schema.hasTable(table)).toBe(true)
  } finally {
    await k.destroy()
  }
})

test('a view using a known trigger name is still an unowned reader of legacy data', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k.raw('CREATE VIEW snapshot_profile_0_insert AS SELECT * FROM snapshot_profile_keys')
    expect(await k('sqlite_master').where('name', 'snapshot_profile_0_insert').orderBy('type').select('type')).toEqual([
      { type: 'trigger' },
      { type: 'view' }
    ])
    await expect(installGeneration(k)).rejects.toThrow('Unowned object references legacy auxiliary data')
    expect(await k.schema.hasTable(metadata)).toBe(false)
  } finally {
    await k.destroy()
  }
})

test('a foreign auxiliary trigger prevents retirement even when its body reads no legacy data', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k.raw('CREATE TRIGGER application_auxiliary_hook AFTER INSERT ON snapshot_profile_keys BEGIN SELECT 1; END')
    await expect(installGeneration(k)).rejects.toThrow('Unowned object references legacy auxiliary data')
    expect(await k.schema.hasTable(metadata)).toBe(false)
  } finally {
    await k.destroy()
  }
})

test('orphan generation objects refuse adoption without replacing their contents', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k.schema.createTable(names.profile, table => {
      table.text('foreignValue')
    })
    await k(names.profile).insert({ foreignValue: 'preserve' })
    await expect(installGeneration(k)).rejects.toThrow('Orphan rebuild schema refuses adoption')
    expect(await k(names.profile)).toEqual([{ foreignValue: 'preserve' }])
    expect(await k.schema.hasTable(metadata)).toBe(false)
  } finally {
    await k.destroy()
  }
})

test('reserved source trigger names refuse while independent application triggers are retained', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k.raw('CREATE TRIGGER snapshot_profile_unowned AFTER INSERT ON tx_labels BEGIN SELECT 1; END')
    await expect(installGeneration(k)).rejects.toThrow('Unknown legacy source trigger')
    await k.raw('DROP TRIGGER snapshot_profile_unowned')
    await k.raw('CREATE TABLE application_events(id INTEGER)')
    await k.raw(
      'CREATE TRIGGER app_snapshot_profile_notice AFTER INSERT ON tx_labels BEGIN INSERT INTO application_events VALUES(NEW.txLabelId); END'
    )
    await installGeneration(k)
    await k('tx_labels').insert(value('tx_labels', 1, 1, 1))
    expect(await k('application_events')).toEqual([{ id: 1 }])
  } finally {
    await k.destroy()
  }
})

test('the installed generation owns every required secondary range index', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await installGeneration(k)
    const required = {
      snapshot_relation_right_v2: ['snapshotTableId', 'snapshotUserId', 'snapshotRightId', 'snapshotLeftId'],
      snapshot_relation_map_v2: ['snapshotTableId', 'snapshotLeftId', 'snapshotRightId', 'snapshotUserId'],
      snapshot_certificate_parent_v2: ['snapshotCertificateId', 'snapshotUserId', 'snapshotFieldName'],
      snapshot_certificate_lookup_v2: ['snapshotFieldName', 'snapshotCertificateId', 'snapshotUserId'],
      snapshot_global_page_v2: ['tableId', 'userId', 'present', 'rowId'],
      snapshot_global_target_v2: ['tableId', 'rowId', 'userId'],
      snapshot_global_request_v2: ['requestId', 'transactionId']
    }
    for (const [name, columns] of Object.entries(required)) {
      const parts: Array<{ key: number; name: string; desc: number }> = await k.raw('PRAGMA index_xinfo(??)', [name])
      expect(parts.filter(part => part.key === 1).map(part => ({ name: part.name, desc: part.desc }))).toEqual(
        columns.map(name => ({ name, desc: 0 }))
      )
    }
  } finally {
    await k.destroy()
  }
})

test.each(['tx_labels_map', 'output_tags_map', 'certificate_fields'])(
  'unsupported additional unique constraint on %s refuses atomically',
  async table => {
    const k = await fixture('BINARY', false, false)
    try {
      const column = table === 'tx_labels_map' ? 'transactionId' : table === 'output_tags_map' ? 'outputId' : 'userId'
      await k.raw('CREATE UNIQUE INDEX unexpected_identity ON ??(??)', [table, column])
      const before = await k('sqlite_master').orderBy('name')
      await expect(installGeneration(k)).rejects.toThrow('Unsupported composite identity constraints')
      expect(await k('sqlite_master').orderBy('name')).toEqual(before)
    } finally {
      await k.destroy()
    }
  }
)

test('changed source schema and missing owned triggers refuse resume without adopting the mismatch', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    const plan = await installGeneration(k)
    await k.raw('CREATE INDEX unexpected_source_index ON tx_labels(userId)')
    await expect(installGeneration(k)).rejects.toThrow('Rebuild source binding mismatch')
    await k.raw('DROP INDEX unexpected_source_index')
    await k.raw('DROP TRIGGER snapshot_identity_before_transactions_INSERT')
    await expect(installGeneration(k)).rejects.toThrow('Rebuild schema definition mismatch')
    expect(await k(metadata).first('complete')).toEqual({ complete: 0 })
    expect(plan.source).not.toBe('')
  } finally {
    await k.destroy()
  }
})

test.each([
  'missing progress',
  'extra progress',
  'negative cursor',
  'wrong text cursor',
  'partial composite cursor',
  'invalid completion',
  'wrong source binding',
  'negative retirement',
  'fractional retirement',
  'excess retirement',
  'published pending',
  'completed with pending streams',
  'missing lock',
  'changed lock'
])('malformed generation state refuses adoption: %s', async kind => {
  const k = await fixture('BINARY', false, false)
  try {
    await k('transactions').insert(value('transactions', 1, 1, 1))
    await installGeneration(k)
    if (kind === 'missing progress') await k(progress).where('stream', 0).delete()
    if (kind === 'extra progress')
      await k(progress).insert({ stream: 12, afterId: 0, afterSecond: 0, afterText: '', complete: 0 })
    if (kind === 'negative cursor') await k(progress).where('stream', 0).update({ afterId: -1 })
    if (kind === 'wrong text cursor') await k(progress).where('stream', 0).update({ afterText: 'unexpected' })
    if (kind === 'partial composite cursor') await k(progress).where('stream', 8).update({ afterId: 1 })
    if (kind === 'invalid completion') await k(progress).where('stream', 0).update({ complete: 2 })
    if (kind === 'wrong source binding') await k(metadata).update({ source: 'changed' })
    if (kind === 'negative retirement') await k(metadata).update({ retireTable: -1 })
    if (kind === 'fractional retirement') await k(metadata).update({ retireTable: 0.5 })
    if (kind === 'excess retirement') await k(metadata).update({ retireTable: 7 })
    if (kind === 'published pending')
      await k('knex_migrations').insert({ name: migration, batch: 99, migration_time: new Date() })
    if (kind === 'completed with pending streams') await k(metadata).update({ complete: 1 })
    if (kind === 'missing lock') await k.schema.dropTable('snapshot_index_install_lock_v2')
    if (kind === 'changed lock') await k.raw('ALTER TABLE snapshot_index_install_lock_v2 ADD COLUMN extra INTEGER')
    const before = await k('transactions')
    await expect(readGenerationIndexState(k)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
    if (kind === 'missing lock' || kind === 'changed lock') {
      await expect(dropGenerationForDataDeletion(k)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
      expect(await k.schema.hasTable(names.profile)).toBe(true)
    }
    expect(await k('transactions')).toEqual(before)
  } finally {
    await k.destroy()
  }
})
