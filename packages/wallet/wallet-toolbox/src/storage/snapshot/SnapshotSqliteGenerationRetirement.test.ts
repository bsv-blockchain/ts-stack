import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { fixture, value } from '../../../test/utils/snapshotSqliteFixtures'
import { installGeneration, names, metadata } from '../schema/snapshotSqliteIndexGeneration'
import { copyGenerationPage } from '../schema/snapshotSqliteIndexBootstrap'
import { retireGenerationPage } from '../schema/snapshotSqliteIndexRetirement'
import { retiredTables } from '../schema/snapshotSqliteLegacyOwnership'

test('obsolete generation cleanup is bounded, rollback-safe, resumable and preserves source data', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    for (let start = 0; start < 600; start += 100)
      await k('transactions').insert(
        Array.from({ length: 100 }, (_, i) => value('transactions', start + i + 1, start + i + 1, 1))
      )
    const source = await k('transactions').orderBy('transactionId')
    const plan = await installGeneration(k)
    await expect(retireGenerationPage(k, plan)).rejects.toThrow('before generation copy')
    for (let i = 0; i < 100; i++) if ((await copyGenerationPage(k, plan)).complete) break
    expect(await retireGenerationPage(k, plan)).toMatchObject({
      removed: 256,
      complete: false,
      table: retiredTables[0]
    })
    expect(await k(retiredTables[0])).toHaveLength(344)
    const failure = new Error('synthetic retirement rollback')
    const inject = (_response: unknown, query: { sql: string }) => {
      if (query.sql.startsWith('delete from `snapshot_global_edges`')) throw failure
    }
    k.on('query-response', inject)
    try {
      await expect(retireGenerationPage(k, plan)).rejects.toBe(failure)
    } finally {
      k.off('query-response', inject)
    }
    expect(await k(retiredTables[0])).toHaveLength(344)
    const resumed = await installGeneration(k)
    let completed = false
    for (let i = 0; i < 100; i++)
      if ((await retireGenerationPage(k, resumed)).complete) {
        completed = true
        break
      }
    expect(completed).toBe(true)
    for (const table of retiredTables) expect(await k.schema.hasTable(table)).toBe(false)
    expect(await k('transactions').orderBy('transactionId')).toEqual(source)
    expect(await k(names.profile)).toHaveLength(600)
    expect(await k(names.edges)).toHaveLength(600)
    expect(await retireGenerationPage(k, resumed)).toEqual({
      complete: true,
      removed: 0,
      table: undefined
    })
  } finally {
    await k.destroy()
  }
})

test('ownership drift refuses cleanup before deleting any legacy rows', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    await k('transactions').insert(value('transactions', 1, 1, 1))
    const plan = await installGeneration(k)
    for (let i = 0; i < 100; i++) if ((await copyGenerationPage(k, plan)).complete) break
    await k.raw(
      'CREATE TRIGGER foreign_old_edge AFTER DELETE ON snapshot_global_edges BEGIN DELETE FROM transactions; END'
    )
    await expect(retireGenerationPage(k, plan)).rejects.toThrow('schema changed')
    expect(await k('transactions')).toHaveLength(1)
    expect(await k(metadata).first('retireTable')).toEqual({ retireTable: 0 })
  } finally {
    await k.destroy()
  }
})

test.each(['source-trigger', 'aux-trigger', 'reference-view'])(
  'unowned %s prevents replacement without changing schema',
  async kind => {
    const k = await fixture('BINARY', false, false)
    try {
      const sql =
        kind === 'source-trigger'
          ? 'CREATE TRIGGER snapshot_profile_custom AFTER INSERT ON transactions BEGIN SELECT 1; END'
          : kind === 'aux-trigger'
            ? 'CREATE TRIGGER foreign_owned_aux AFTER DELETE ON snapshot_global_edges BEGIN DELETE FROM transactions; END'
            : 'CREATE VIEW foreign_aux_view AS SELECT * FROM snapshot_profile_keys'
      await k.raw(sql)
      const before = await k('sqlite_master').orderBy('name')
      await expect(installGeneration(k)).rejects.toThrow(
        /Unknown legacy source trigger|Unowned object references legacy auxiliary data|Unknown legacy auxiliary trigger/
      )
      expect(await k('sqlite_master').orderBy('name')).toEqual(before)
    } finally {
      await k.destroy()
    }
  }
)

test('shared logical rowId values across key families still retire at most256 physical rows', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    for (let start = 0; start < 300; start += 100) {
      await k('transactions').insert(
        Array.from({ length: 100 }, (_, i) => value('transactions', start + i + 1, start + i + 1, 1))
      )
      await k('proven_tx_reqs').insert(
        Array.from({ length: 100 }, (_, i) => value('proven_tx_reqs', start + i + 1, start + i + 1, 1))
      )
    }
    const plan = await installGeneration(k)
    for (let i = 0; i < 100; i++) if ((await copyGenerationPage(k, plan)).complete) break
    let before = 0,
      removed = 0
    for (let i = 0; i < 100; i++) {
      before = Number((await k('snapshot_global_keys').count({ count: '*' }).first())!.count)
      const page = await retireGenerationPage(k, plan)
      if (page.table === 'snapshot_global_keys') {
        removed = page.removed
        expect(removed).toBe(256)
        const after = Number((await k('snapshot_global_keys').count({ count: '*' }).first())!.count)
        expect(before - after).toBe(256)
        break
      }
    }
    expect(before).toBe(600)
    expect(removed).toBe(256)
    expect(await k('transactions')).toHaveLength(300)
    expect(await k(names.keys)).toHaveLength(600)
  } finally {
    await k.destroy()
  }
})

test.each(['{', 'null', '[null]', '[{"type":"table","name":"foreign","tbl_name":"users","sql":null}]'])(
  'invalid retirement ownership receipt refuses before deletion: %s',
  async legacy => {
    const k = await fixture('BINARY', false, false)
    try {
      await k('transactions').insert(value('transactions', 1, 1, 1))
      const plan = await installGeneration(k)
      let done = false
      for (let n = 0; n < 50 && !done; n++) done = (await copyGenerationPage(k, plan)).complete
      expect(done).toBe(true)
      await k(metadata).update({ legacy })
      const before = await k('snapshot_global_edges')
      await expect(retireGenerationPage(k, plan)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
      expect(await k('snapshot_global_edges')).toEqual(before)
      expect(await k(metadata).first('retireTable')).toEqual({ retireTable: 0 })
      expect(await k('transactions')).toHaveLength(1)
    } finally {
      await k.destroy()
    }
  }
)
