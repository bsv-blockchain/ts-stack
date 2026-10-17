import { importJournalFixture } from './Brc38ImportJournalFixture'
import { commitBrc38ImportJournalStep, readBrc38ImportJournal } from './Brc38ImportJournal'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'

describe('actual durable import mapping charge', () => {
  let fixture: Awaited<ReturnType<typeof importJournalFixture>>
  beforeEach(async () => {
    fixture = await importJournalFixture()
  })
  afterEach(async () => {
    await fixture.close()
  })
  async function receipt() {
    return await fixture.observer.transaction(async trx => await readBrc38ImportJournal(trx, fixture.admission))
  }
  async function state() {
    return {
      journal: await fixture.observer('brc38_import_journal').first(),
      maps: await fixture.observer('brc38_import_ids'),
      rows: await fixture.observer('native_import_rows'),
      clock: await fixture.observer('native_import_clock')
    }
  }
  test.each([0, 2])('declared %i mappings cannot commit one actual insertion', async declared => {
    await fixture.prepare()
    const before = await state(),
      page = fixture.step(0, 1)
    await expect(
      fixture.k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(
            trx,
            fixture.admission,
            { ...page, mappedIds: declared },
            await fixture.destinationSha256(trx),
            async () => await fixture.apply(trx, page)
          )
      )
    ).rejects.toThrow('stale')
    expect(await state()).toEqual(before)
    await fixture.commit(page)
    expect((await receipt()).mappedIds).toBe(1)
  })
  test('an invented charge without a persisted mapping rolls back native rows and checkpoint', async () => {
    await fixture.prepare()
    const before = await state(),
      page = fixture.step(0, 1)
    await expect(
      fixture.k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(
            trx,
            fixture.admission,
            page,
            await fixture.destinationSha256(trx),
            async () => {
              await trx('native_import_rows').insert({ rowId: 100, userId: 7, value: 'synthetic' })
              return await fixture.destinationSha256(trx)
            }
          )
      )
    ).rejects.toThrow('stale')
    expect(await state()).toEqual(before)
  })
  test.each(['bindingSha256', 'archiveSha256', 'userId'] as const)(
    'actual insertion cannot charge a foreign %s',
    async field => {
      await fixture.prepare()
      const before = await state()
      await expect(
        fixture.k.transaction(async trx => {
          const scope = {
            ...fixture.admission.scope,
            [field]: field === 'userId' ? 8 : 'f'.repeat(64)
          }
          const ids = await loadBrc38ImportIdMap(trx, scope, [
            { entity: 'transaction', incomingId: 1e21, required: false }
          ])
          ids.map.transaction.idMap[1e21] = 101
          await ids.persist()
        })
      ).rejects.toThrow('scope or quota')
      expect(await state()).toEqual(before)
    }
  )
  test('actual SQL quota refuses an uncharged insertion before native checkpoint can publish', async () => {
    const selected = { ...fixture.admission, maximumJournalLogicalBytes: 4096 }
    await fixture.prepare(selected)
    const before = await state()
    await expect(
      fixture.k.transaction(async trx => {
        const ids = await loadBrc38ImportIdMap(trx, selected.scope, [
          { entity: 'transaction', incomingId: 1, required: false }
        ])
        ids.map.transaction.idMap[1] = 101
        await ids.persist()
      })
    ).rejects.toThrow('scope or quota')
    expect(await state()).toEqual(before)
  })
  test.each(['mappedIds', 'maximumMappedIds', 'cleanupAllowed', 'userId'] as const)(
    'a changed durable %s invalidates continuation before apply',
    async field => {
      await fixture.prepare()
      await fixture.commit(fixture.step(0, 1))
      const row = await fixture.k('brc38_import_journal').first()
      await fixture.k('brc38_import_journal').update({ [field]: row[field] + 1 })
      const apply = jest.fn()
      await expect(
        fixture.k.transaction(
          async trx =>
            await commitBrc38ImportJournalStep(
              trx,
              fixture.admission,
              fixture.step(1, 1),
              await fixture.destinationSha256(trx),
              apply
            )
        )
      ).rejects.toThrow('stale')
      expect(apply).not.toHaveBeenCalled()
    }
  )
  test.each(['update', 'delete'] as const)('existing mappings cannot %s during normal import', async operation => {
    await fixture.prepare()
    await fixture.commit(fixture.step(0, 1))
    const before = await state()
    await expect(
      fixture.k.transaction(async trx => {
        const rows = trx('brc38_import_ids').where(fixture.admission.scope)
        if (operation === 'update') await rows.update({ localId: 102 })
        else await rows.delete()
      })
    ).rejects.toThrow(operation === 'update' ? 'immutable' : 'owned cleanup')
    expect(await state()).toEqual(before)
  })
  test('multi-row insertion is charged once per actual map; replay cannot charge or apply again', async () => {
    await fixture.prepare()
    const page = fixture.step(0, 3),
      first = await fixture.commit(page)
    expect((await state()).journal.mappedIds).toBe(3)
    expect(first).toMatchObject({ mappedIds: 3, logicalBytes: 5632 })
    const replay = jest.fn()
    expect(
      await fixture.k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(trx, fixture.admission, page, await fixture.destinationSha256(trx), replay)
      )
    ).toEqual(first)
    expect(replay).not.toHaveBeenCalled()
    expect((await state()).journal.mappedIds).toBe(3)
  })
  test('the bounded indexed counter does not count or materialize the accumulated mapping table per page', async () => {
    await fixture.prepare()
    const queries: string[] = []
    fixture.k.on('query', (query: { sql: string }) => {
      queries.push(query.sql)
    })
    await fixture.commit(fixture.step(0, 3))
    await fixture.commit(fixture.step(3, 2))
    expect((await receipt()).mappedIds).toBe(5)
    const counts = queries.filter(sql => /count\s*\(/i.test(sql))
    expect(
      counts.every(sql =>
        /\bfrom\s+(?:[`"]?main[`"]?\.)?[`"]?sqlite_(?:schema|master|temp_schema)(?:[`"]|\b)/i.test(sql)
      )
    ).toBe(true)
    const loads = queries.filter(sql => /^select/i.test(sql) && sql.includes('brc38_import_ids'))
    expect(loads).toHaveLength(2)
    expect(loads.every(sql => sql.includes('incomingId') && sql.includes(' in '))).toBe(true)
  })
  test('a removed source-owned charge trigger is refused before any continuation mutation', async () => {
    await fixture.prepare()
    const original = await fixture
      .k('sqlite_schema')
      .where({ type: 'trigger', name: 'brc38_import_ids_insert_charge' })
      .first('sql')
    expect(typeof original.sql).toBe('string')
    await fixture.k.raw('DROP TRIGGER brc38_import_ids_insert_charge')
    const before = await state()
    await expect(fixture.commit(fixture.step(0, 1))).rejects.toThrow('schema differs')
    expect(await state()).toEqual(before)
    // The guarded installer must refuse partial families. Restore only the
    // fixture's exact original SQL; the next commit freshly validates it.
    await fixture.k.raw(original.sql)
    expect((await fixture.commit(fixture.step(0, 1))).mappedIds).toBe(1)
  })
})
