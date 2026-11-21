import createKnex, { type Knex } from 'knex'
import { brc38NativeLocalBaselineTables } from './Brc38NativeLocalBaselineTables'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { readBrc38ComposedDatabaseImage } from './Brc38ComposedDatabaseImageNode'

// UNRUN SQL-image DATA cases. These stock fixtures deliberately make no
// authenticated archive, original merge, native kernel, receiving owner,
// publication, selection or production qualification claim.
describe('complete composed SQL image data', () => {
  let db: Knex, working: Brc38WorkingAllocation
  beforeEach(async () => {
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    working = new Brc38WorkingAllocation(1048576)
    for (const table of brc38NativeLocalBaselineTables) await db.raw('CREATE TABLE ??(value)', [table])
    await db.raw('CREATE TABLE image_values(a,b,c,d,e)')
  })
  afterEach(async () => await db.destroy())
  const image = async (read = 64): Promise<Awaited<ReturnType<typeof readBrc38ComposedDatabaseImage>>> =>
    await db.transaction(
      async k =>
        await readBrc38ComposedDatabaseImage(
          k,
          {
            maximumPhysicalBytes: 1048576,
            maximumReadBytes: read,
            expiresAt: Date.now() + 60000,
            workingAllocation: working
          },
          () => {
            if (k.isCompleted()) throw new Error('Original fixture read ended')
          }
        )
    )
  test('all bytes, exact signed rowids and SQLite types survive changing only read chunk size', async () => {
    const bytes = Buffer.alloc(65539)
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
    await db.raw('INSERT INTO image_values(rowid,a,b,c,d,e) VALUES(CAST(? AS INTEGER),CAST(? AS INTEGER),?,?,?,?)', [
      '-9223372036854775808',
      '9223372036854775807',
      'é\u0000終',
      bytes,
      null,
      1.0000000000000002
    ])
    await db.raw('INSERT INTO image_values(rowid,a,b,c,d,e) VALUES(CAST(? AS INTEGER),?,?,?,?,?)', [
      '9223372036854775807',
      '',
      Buffer.alloc(0),
      null,
      '1',
      1
    ])
    const original = await image(64)
    expect(await image(16384)).toEqual(original)
    expect(original.tables).toBe(brc38NativeLocalBaselineTables.length + 1)
    expect(original.rows).toBe('2')
    expect(BigInt(original.cellBytes)).toBeGreaterThan(BigInt(bytes.length))
    expect(working.used).toBe(0)
  })
  test('last-byte corruption, text after NUL, numeric type and close real values produce different images', async () => {
    const bytes = Buffer.alloc(65539, 7)
    await db('image_values').insert({ a: bytes, b: 'head\u0000tail', c: 1, d: 1.0000000000000002, e: null })
    const original = await image()
    bytes[bytes.length - 1] ^= 1
    await db('image_values').update({ a: bytes })
    expect((await image()).sha256).not.toBe(original.sha256)
    bytes[bytes.length - 1] ^= 1
    await db('image_values').update({ a: bytes, b: 'head\u0000TAIL' })
    expect((await image()).sha256).not.toBe(original.sha256)
    await db('image_values').update({ b: 'head\u0000tail', c: '1' })
    expect((await image()).sha256).not.toBe(original.sha256)
    await db('image_values').update({ c: 1, d: 1.0000000000000004 })
    expect((await image()).sha256).not.toBe(original.sha256)
    await db('image_values').update({ d: 1.0000000000000002 })
    expect(await image()).toEqual(original)
  })
  test('recovery rows, empty values and extra schema cannot disappear behind wallet counts', async () => {
    const original = await image()
    await db('snapshot_reconciliation_window_progress').insert({ value: 'durable recovery' })
    expect((await image()).sha256).not.toBe(original.sha256)
    await db('snapshot_reconciliation_window_progress').delete()
    expect(await image()).toEqual(original)
    await db('image_values').insert({ a: null, b: null, c: null, d: null, e: null })
    const nulls = await image()
    await db('image_values').update({ a: '', b: Buffer.alloc(0) })
    expect((await image()).sha256).not.toBe(nulls.sha256)
    const values = await image()
    await db.raw('CREATE INDEX image_extra ON image_values(a)')
    expect((await image()).sha256).not.toBe(values.sha256)
    await db.raw('DROP TABLE payment_replays')
    await expect(image()).rejects.toThrow('Composed database image')
    expect(working.used).toBe(0)
  })
  test('original composite WITHOUT ROWID custody indexes retain every key and complete payload', async () => {
    await db.raw(
      'CREATE TABLE image_custody(importId TEXT,fromRow INTEGER,payload BLOB,PRIMARY KEY(importId,fromRow)) WITHOUT ROWID'
    )
    const first = '00000000-0000-4000-8000-000000000001',
      second = '00000000-0000-4000-8000-000000000002',
      payload = Buffer.alloc(32771, 19)
    await db('image_custody').insert([
      { importId: second, fromRow: 1, payload: Buffer.alloc(0) },
      { importId: first, fromRow: 7, payload },
      { importId: first, fromRow: 1, payload: null }
    ])
    const original = await image()
    expect(original.rows).toBe('3')
    expect(await image(16384)).toEqual(original)
    await db('image_custody').where({ importId: first, fromRow: 7 }).delete()
    expect((await image()).sha256).not.toBe(original.sha256)
    await db('image_custody').insert({ importId: first, fromRow: 7, payload })
    expect(await image()).toEqual(original)
    await db('image_custody').where({ importId: second, fromRow: 1 }).update({ fromRow: 2 })
    expect((await image()).sha256).not.toBe(original.sha256)
  })
  test('explicit rowId composite keys retain every row through unshadowed aliases and all-shadowed ordinary keys refuse', async () => {
    await db.raw(
      'CREATE TABLE image_explicit_rowid(lineage TEXT,rowId INTEGER,payload BLOB,PRIMARY KEY(lineage,rowId)) WITHOUT ROWID'
    )
    await db('image_explicit_rowid').insert([
      { lineage: 'a', rowId: 7, payload: Buffer.from([0, 255, 1]) },
      { lineage: 'b', rowId: 7, payload: Buffer.alloc(0) }
    ])
    const original = await image()
    expect(original.rows).toBe('2')
    expect(await image(16384)).toEqual(original)
    await db('image_explicit_rowid').where({ lineage: 'a', rowId: 7 }).update({ rowId: 8 })
    expect((await image()).sha256).not.toBe(original.sha256)
    await db('image_explicit_rowid').where({ lineage: 'a', rowId: 8 }).update({ rowId: 7 })
    expect(await image()).toEqual(original)
    for (const shadowed of [['rowId'], ['rowId', '_rowid_'], ['oid']]) {
      await db.raw(
        'CREATE TABLE image_shadow(' + shadowed.map(name => '"' + name + '" INTEGER').join(',') + ',payload BLOB)'
      )
      await db('image_shadow').insert([
        { ...Object.fromEntries(shadowed.map(name => [name, 7])), payload: Buffer.from([1, 0, 255]) },
        { ...Object.fromEntries(shadowed.map(name => [name, 7])), payload: Buffer.alloc(0) }
      ])
      const shadow = await image()
      expect(shadow.rows).toBe('4')
      expect(await image(16384)).toEqual(shadow)
      await db('image_shadow')
        .where({ payload: Buffer.alloc(0) })
        .update({ payload: Buffer.from([9]) })
      expect((await image()).sha256).not.toBe(shadow.sha256)
      await db('image_shadow')
        .where({ payload: Buffer.from([9]) })
        .update({ payload: Buffer.alloc(0) })
      expect(await image()).toEqual(shadow)
      await db.raw('DROP TABLE image_shadow')
    }
    await db.raw('CREATE TABLE image_shadow(rowId INTEGER,_rowid_ INTEGER,oid INTEGER)')
    await expect(image()).rejects.toThrow('Composed database image')
    expect(working.used).toBe(0)
  })
  test('actual read loss, abort, expiry, unsupported key storage and exhausted allocation refuse with drained charge', async () => {
    const controller = new AbortController()
    controller.abort(new Error('fixture image cancelled'))
    await expect(
      db.transaction(
        async k =>
          await readBrc38ComposedDatabaseImage(
            k,
            {
              maximumPhysicalBytes: 1048576,
              maximumReadBytes: 64,
              expiresAt: Date.now() + 60000,
              workingAllocation: working,
              signal: controller.signal
            },
            () => {}
          )
      )
    ).rejects.toThrow('fixture image cancelled')
    await expect(
      db.transaction(
        async k =>
          await readBrc38ComposedDatabaseImage(
            k,
            {
              maximumPhysicalBytes: 1048576,
              maximumReadBytes: 64,
              expiresAt: Date.now() - 1,
              workingAllocation: working
            },
            () => {}
          )
      )
    ).rejects.toThrow('Composed database image')
    await expect(
      db.transaction(
        async k =>
          await readBrc38ComposedDatabaseImage(
            k,
            {
              maximumPhysicalBytes: 1048576,
              maximumReadBytes: 64,
              expiresAt: Date.now() + 60000,
              workingAllocation: working
            },
            () => {
              throw new Error('actual read no longer retained')
            }
          )
      )
    ).rejects.toThrow('actual read no longer retained')
    const held = working.claim(600000)
    try {
      await expect(image()).rejects.toThrow('original combined working allocation')
    } finally {
      held.close()
    }
    await db.raw('CREATE TABLE image_without_rowid(id BLOB PRIMARY KEY) WITHOUT ROWID')
    await db('image_without_rowid').insert({ id: Buffer.from([1, 2, 3]) })
    await expect(image()).rejects.toThrow('Composed database image')
    expect(working.used).toBe(0)
  })
})
