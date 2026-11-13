import knex, { type Knex } from 'knex'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadBrc38ImportIdMap,
  brc38ImportIncomingId,
  type Brc38ImportIdReference,
  type Brc38ImportMapScope
} from './Brc38ImportIdMap'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import { parseBRC38Json } from './index'
import { semanticStageFixture, importToMemoryStage } from './Brc38SemanticStageFixture'

const scope: Brc38ImportMapScope = {
  importId: 'aa3f7330-2e40-4bfe-9723-f69f619b7ac9',
  bindingSha256: 'a'.repeat(64),
  archiveSha256: 'b'.repeat(64),
  userId: 7
}
function reference(
  incomingId: number,
  required = false,
  entity: keyof SyncMap = 'transaction'
): Brc38ImportIdReference {
  return { entity, incomingId, required }
}

describe('bounded distinct private-import mappings', () => {
  let root: string, k: Knex, observer: Knex
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'brc38-import-id-map-'))
    const config: Knex.Config = {
      client: 'better-sqlite3',
      connection: { filename: join(root, 'maps.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    }
    k = knex(config)
    observer = knex(config)
    await k.raw('PRAGMA journal_mode=WAL')
    await k.schema.createTable('brc38_import_ids', table => {
      table.text('importId').notNullable()
      table.text('bindingSha256').notNullable()
      table.text('archiveSha256').notNullable()
      table.integer('userId').notNullable()
      table.text('entity').notNullable()
      table.text('incomingId').notNullable()
      table.bigInteger('localId').notNullable()
      table.primary(['importId', 'bindingSha256', 'archiveSha256', 'userId', 'entity', 'incomingId'])
    })
    await k.schema.createTable('brc38_import_steps', table => {
      table.text('importId').primary()
      table.integer('sequence').notNullable()
    })
  })
  afterEach(async () => {
    await observer.destroy()
    await k.destroy()
    await rm(root, { recursive: true, force: true })
  })
  async function stored(entity: keyof SyncMap, incomingId: number, localId: number): Promise<void> {
    await k('brc38_import_ids').insert({
      ...scope,
      entity,
      incomingId: String(incomingId),
      localId
    })
  }

  test('requires the actual destination transaction before any mapping query', async () => {
    const queries: string[] = []
    const record = (query: { sql: string }): void => {
      queries.push(query.sql)
    }
    k.on('query', record)
    try {
      await expect(loadBrc38ImportIdMap(k as Knex.Transaction, scope, [reference(1)])).rejects.toThrow(
        'invalid or inconsistent'
      )
      expect(queries).toEqual([])
    } finally {
      k.off('query', record)
    }
  })

  test.each([
    ['null', null],
    ['array', []],
    ['invalid import', { ...scope, importId: 'other' }],
    ['invalid binding', { ...scope, bindingSha256: 'a' }],
    ['invalid archive', { ...scope, archiveSha256: 'b' }],
    ['invalid profile', { ...scope, userId: 0.5 }]
  ])('refuses %s scope before mapping queries', async (_label, selected) => {
    const selects: string[] = []
    const record = (query: { sql: string }): void => {
      if (/^select/i.test(query.sql)) selects.push(query.sql)
    }
    k.on('query', record)
    try {
      await expect(
        k.transaction(async trx => await loadBrc38ImportIdMap(trx, selected as Brc38ImportMapScope, [reference(1)]))
      ).rejects.toThrow('invalid or inconsistent')
      expect(selects).toEqual([])
    } finally {
      k.off('query', record)
    }
  })

  test('keeps all entity namespaces distinct and leaves legacy synchronization untouched', async () => {
    const entities = Object.keys(createSyncMap()) as Array<keyof SyncMap>
    await k.transaction(async trx => {
      const prepared = await loadBrc38ImportIdMap(
        trx,
        scope,
        entities.map(entity => reference(1, false, entity))
      )
      entities.forEach((entity, index) => {
        prepared.map[entity].idMap[1] = 100 + index
      })
      await prepared.persist()
    })
    const rows = await observer('brc38_import_ids').where(scope).orderBy('localId')
    expect(rows.map(row => [row.entity, row.incomingId, row.localId])).toEqual(
      entities.map((entity, index) => [entity, '1', 100 + index])
    )
    expect(await k.schema.hasTable('snapshot_sync_ids')).toBe(false)
    expect(await k.schema.hasTable('sync_states')).toBe(false)
  })

  test.each(['importId', 'bindingSha256', 'archiveSha256', 'userId'] as const)(
    'does not borrow another %s mapping',
    async field => {
      await stored('transaction', 1, 101)
      const changed = {
        userId: 8,
        importId: randomUUID(),
        bindingSha256: 'c'.repeat(64),
        archiveSha256: 'c'.repeat(64)
      }
      const other = { ...scope, [field]: changed[field] }
      await expect(
        k.transaction(async trx => await loadBrc38ImportIdMap(trx, other, [reference(1, true)]))
      ).rejects.toThrow('parent mapping is missing')
      expect(await observer('brc38_import_ids').where(scope)).toHaveLength(1)
    }
  )

  test('resumes a committed page from the actual database after an acknowledgement is lost', async () => {
    const failedAcknowledgement = new Error('Synthetic acknowledgement lost after commit')
    await expect(
      (async () => {
        await k.transaction(async trx => {
          const prepared = await loadBrc38ImportIdMap(trx, scope, [reference(1)])
          prepared.map.transaction.idMap[1] = 101
          await prepared.persist()
          await trx('brc38_import_steps').insert({ importId: scope.importId, sequence: 1 })
        })
        throw failedAcknowledgement
      })()
    ).rejects.toBe(failedAcknowledgement)
    const writes: string[] = []
    const record = (query: { sql: string }): void => {
      if (/^insert|^update|^delete/i.test(query.sql)) writes.push(query.sql)
    }
    k.on('query', record)
    try {
      await k.transaction(async trx => {
        const receipt = await trx('brc38_import_steps').where({ importId: scope.importId }).first()
        expect(receipt.sequence).toBe(1)
        const prepared = await loadBrc38ImportIdMap(trx, scope, [reference(1, true)])
        expect(prepared.map.transaction.idMap).toEqual({ 1: 101 })
        await prepared.persist()
      })
      expect(writes).toEqual([])
    } finally {
      k.off('query', record)
    }
    expect(await observer('brc38_import_ids').where(scope)).toHaveLength(1)
  })

  test('rolls mappings and a checkpoint back together on an actual destination failure', async () => {
    const failure = new Error('Synthetic bounded destination write failed')
    await expect(
      k.transaction(async trx => {
        const prepared = await loadBrc38ImportIdMap(trx, scope, [reference(1)])
        prepared.map.transaction.idMap[1] = 101
        await prepared.persist()
        await trx('brc38_import_steps').insert({ importId: scope.importId, sequence: 1 })
        throw failure
      })
    ).rejects.toBe(failure)
    expect(await observer('brc38_import_ids')).toEqual([])
    expect(await observer('brc38_import_steps')).toEqual([])
  })

  test('refuses missing parents before writes and preserves existing mappings', async () => {
    await stored('transaction', 1, 101)
    await expect(
      k.transaction(async trx => await loadBrc38ImportIdMap(trx, scope, [reference(1, true), reference(2, true)]))
    ).rejects.toThrow('parent mapping is missing')
    const rows = await observer('brc38_import_ids').where(scope)
    expect(rows.map(row => [row.incomingId, row.localId])).toEqual([['1', 101]])
  })

  test.each([
    ['non-numeric text', 'not an ID'],
    ['blob', Buffer.alloc(8192)],
    ['fraction', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['oversized text', 'x'.repeat(8192)]
  ] as const)('refuses corrupt %s local IDs before loading SQL payloads', async (_label, localId) => {
    await k('brc38_import_ids').insert({
      ...scope,
      entity: 'transaction',
      incomingId: '1',
      localId
    })
    await expect(k.transaction(async trx => await loadBrc38ImportIdMap(trx, scope, [reference(1)]))).rejects.toThrow(
      'invalid or inconsistent'
    )
    const [{ bytes }] = await observer('brc38_import_ids').select(
      observer.raw('length(CAST(localId AS BLOB)) AS bytes')
    )
    expect(bytes).toBeGreaterThan(0)
  })

  test.each([0, -0, -1, Number.MAX_SAFE_INTEGER + 1, 1e21, -1e21, Number.MAX_VALUE])(
    'persists accepted incoming integer %p as canonical text through required-parent resume',
    async incomingId => {
      await k.transaction(async trx => {
        const prepared = await loadBrc38ImportIdMap(trx, scope, [reference(incomingId)])
        prepared.map.transaction.idMap[incomingId] = 101
        await prepared.persist()
      })
      const row = await observer('brc38_import_ids').where(scope).first()
      expect(row.incomingId).toBe(String(incomingId))
      const [{ kind }] = await observer('brc38_import_ids').select(observer.raw('typeof(incomingId) kind'))
      expect(kind).toBe('text')
      await k.transaction(async trx => {
        const resumed = await loadBrc38ImportIdMap(trx, scope, [reference(incomingId, true)])
        expect(resumed.map.transaction.idMap[incomingId]).toBe(101)
        await resumed.persist()
      })
      expect(await observer('brc38_import_ids').where(scope)).toHaveLength(1)
    }
  )

  test.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 1e21, Number.MAX_VALUE])(
    'retains independently decoded/semantically verified basket relation for incoming ID %p',
    async incomingId => {
      const data = semanticStageFixture()
      data.tables.outputBaskets[0].basketId = incomingId
      data.tables.outputs[0].basketId = incomingId
      const original = JSON.stringify(data),
        decoded = parseBRC38Json(original)
      expect(decoded.tables.outputBaskets[0].basketId).toBe(incomingId)
      expect(decoded.tables.outputs[0].basketId).toBe(incomingId)
      expect((await importToMemoryStage(data)).sealed).toBe(1)
      expect(JSON.stringify(data)).toBe(original)
      await k.raw('PRAGMA foreign_keys=ON')
      await k.schema.createTable('native_import_baskets', table => {
        table.integer('basketId').primary()
      })
      await k.schema.createTable('native_import_outputs', table => {
        table.integer('outputId').primary()
        table.integer('basketId').notNullable().references('basketId').inTable('native_import_baskets')
      })
      await k.transaction(async trx => {
        await trx('native_import_baskets').insert({ basketId: 101 })
        const mapped = await loadBrc38ImportIdMap(trx, scope, [reference(incomingId, false, 'outputBasket')])
        mapped.map.outputBasket.idMap[incomingId] = 101
        await mapped.persist()
      })
      await k.transaction(async trx => {
        const mapped = await loadBrc38ImportIdMap(trx, scope, [
          reference(decoded.tables.outputs[0].basketId as number, true, 'outputBasket')
        ])
        await trx('native_import_outputs').insert({
          outputId: 201,
          basketId: mapped.map.outputBasket.idMap[incomingId]
        })
        await mapped.persist()
      })
      const joined = await observer('native_import_outputs as o')
        .join('native_import_baskets as b', 'o.basketId', 'b.basketId')
        .select('o.outputId', 'b.basketId')
      expect(joined).toEqual([{ outputId: 201, basketId: 101 }])
    }
  )

  test.each([0, -1])('preserves actual signed native destination/profile ID %p', async id => {
    await k.schema.createTable('native_import_rows', table => {
      table.integer('id').primary()
    })
    await k('native_import_rows').insert({ id })
    const native = await observer('native_import_rows').first('id')
    expect(native.id).toBe(id)
    await k('brc38_import_ids').insert({
      ...scope,
      userId: id,
      entity: 'transaction',
      incomingId: '0',
      localId: id
    })
    await k.transaction(async trx => {
      const prepared = await loadBrc38ImportIdMap(trx, { ...scope, userId: id }, [reference(0, true)])
      expect(prepared.map.transaction.idMap[0]).toBe(native.id)
      await prepared.persist()
    })
  })

  test("zero and negative-zero share the decoder's existing numeric identity", async () => {
    expect(brc38ImportIncomingId(-0)).toBe(brc38ImportIncomingId(0))
    await k.transaction(async trx => {
      const prepared = await loadBrc38ImportIdMap(trx, scope, [reference(-0), reference(0)])
      prepared.map.transaction.idMap[0] = 101
      await prepared.persist()
    })
    expect(await observer('brc38_import_ids')).toHaveLength(1)
  })

  test.each([NaN, Infinity, -Infinity, 0.5, '1'])('retains rejection of non-integer incoming value %p', incomingId => {
    expect(() => brc38ImportIncomingId(incomingId)).toThrow('invalid or inconsistent')
  })

  test('uses only the requested IDs with bounded sequential queries and insert batches', async () => {
    const queries: Array<{ sql: string; bindings: readonly unknown[] }> = []
    const record = (query: { sql: string; bindings?: readonly unknown[] }): void => {
      queries.push({ sql: query.sql, bindings: query.bindings ?? [] })
    }
    k.on('query', record)
    try {
      await k.transaction(async trx => {
        const refs = Array.from({ length: 4096 }, (_, index) => reference(index + 1))
        const prepared = await loadBrc38ImportIdMap(trx, scope, refs)
        for (const ref of refs) prepared.map.transaction.idMap[ref.incomingId] = ref.incomingId + 10000
        await prepared.persist()
      })
    } finally {
      k.off('query', record)
    }
    const selects = queries.filter(query => /^select/i.test(query.sql))
    const inserts = queries.filter(query => /^insert/i.test(query.sql))
    expect(selects).toHaveLength(32)
    expect(inserts).toHaveLength(32)
    expect(selects.every(query => query.sql.includes(' in (') && !/count|offset/i.test(query.sql))).toBe(true)
    expect(selects.every(query => query.bindings.length <= 999)).toBe(true)
    selects.forEach((query, batch) => {
      expect(query.bindings.slice(-128)).toEqual(
        Array.from({ length: 128 }, (_, index) => String(batch * 128 + index + 1))
      )
    })
    expect(inserts.every(query => query.bindings.length === 128 * 7)).toBe(true)
    expect(await observer('brc38_import_ids').where(scope)).toHaveLength(4096)
  })

  test('refuses excess or invalid preparation before issuing a mapping query', async () => {
    const selects: string[] = []
    const record = (query: { sql: string }): void => {
      if (/^select/i.test(query.sql)) selects.push(query.sql)
    }
    k.on('query', record)
    try {
      await expect(
        k.transaction(
          async trx =>
            await loadBrc38ImportIdMap(
              trx,
              scope,
              Array.from({ length: 4097 }, (_, index) => reference(index + 1))
            )
        )
      ).rejects.toThrow('4096 ID references')
      await expect(
        k.transaction(async trx => await loadBrc38ImportIdMap(trx, scope, [reference(0.5)]))
      ).rejects.toThrow('invalid or inconsistent')
      expect(selects).toEqual([])
    } finally {
      k.off('query', record)
    }
  })

  test.each(['replace', 'remove', 'extra', 'invalid'] as const)(
    'refuses %s mutation before the first insert',
    async change => {
      await stored('transaction', 1, 101)
      await expect(
        k.transaction(async trx => {
          const prepared = await loadBrc38ImportIdMap(trx, scope, [reference(1), reference(2)])
          prepared.map.transaction.idMap[2] = 102
          if (change === 'replace') prepared.map.transaction.idMap[1] = 201
          if (change === 'remove') delete prepared.map.transaction.idMap[1]
          if (change === 'extra') prepared.map.transaction.idMap[3] = 103
          if (change === 'invalid') prepared.map.transaction.idMap[2] = 0.5
          await prepared.persist()
        })
      ).rejects.toThrow('invalid or inconsistent')
      expect((await observer('brc38_import_ids').where(scope)).map(row => [row.incomingId, row.localId])).toEqual([
        ['1', 101]
      ])
    }
  )

  test('captures detached scope/references and refuses consuming a preparation twice', async () => {
    const selected = { ...scope },
      refs = [reference(1)]
    await k.transaction(async trx => {
      const prepared = await loadBrc38ImportIdMap(trx, selected, refs)
      selected.userId = 8
      refs[0] = reference(2)
      prepared.map.transaction.idMap[1] = 101
      await prepared.persist()
      await expect(prepared.persist()).rejects.toThrow('already consumed')
    })
    expect((await observer('brc38_import_ids').where(scope)).map(row => [row.incomingId, row.localId])).toEqual([
      ['1', 101]
    ])
  })
})
