import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { readRow } from './Brc38PublishedProfileReceiptNode'

// Ordinary bounded SQLite catalog fixtures only. Reading a row does not grant
// native process, inventory, wallet, filesystem or activation authority.
describe('published-profile catalog transport boundaries', () => {
  let db: Knex
  const fixedJson = JSON.stringify({ ordinaryReceiptFixture: true })
  const fixedSha256 = createHash('sha256').update(fixedJson).digest('hex')
  const receiving = {
    slot: 1,
    state: 'RECEIVING',
    fixedJson,
    fixedSha256,
    copySha256: null,
    copyBytes: null
  }
  const ready = { ...receiving, state: 'READY', copySha256: 'a'.repeat(64), copyBytes: 4096 }

  beforeEach(async () => {
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    await db.schema.createTable('profile', table => {
      table.integer('slot').primary()
      table.text('state').notNullable()
      table.text('fixedJson').notNullable()
      table.text('fixedSha256').notNullable()
      table.text('copySha256').nullable()
      table.bigInteger('copyBytes').nullable()
    })
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('receiving retains absent copy fields without claiming completion', async () => {
    await db('profile').insert(receiving)
    await expect(readRow(db)).resolves.toEqual({
      state: receiving.state,
      fixedJson,
      fixedSha256,
      copySha256: null,
      copyBytes: null
    })
  })
  test('a completed copy retains its independent original digest and extent', async () => {
    await db('profile').insert(ready)
    await expect(readRow(db)).resolves.toEqual({
      state: ready.state,
      fixedJson,
      fixedSha256,
      copySha256: ready.copySha256,
      copyBytes: ready.copyBytes
    })
  })
  test('an absent fixed row is refused', async () => {
    await expect(readRow(db)).rejects.toThrow('Published profile catalog differs')
  })
  test.each([
    { label: 'unrecognized durable state', update: { state: 'STALLED' } },
    { label: 'metadata above the fixed text extent', update: { fixedJson: 'x'.repeat(8193) } },
    { label: 'digest outside its fixed extent', update: { fixedSha256: 'a'.repeat(65) } },
    { label: 'same-size digest for different metadata', update: { fixedSha256: 'b'.repeat(64) } }
  ])('refuses $label before accepting the catalog row', async ({ update }) => {
    await db('profile').insert({ ...receiving, ...update })
    await expect(readRow(db)).rejects.toThrow('Published profile catalog differs')
  })
  test.each([
    { label: 'absent copy digest', update: { copySha256: null } },
    { label: 'digest outside the fixed extent', update: { copySha256: 'a'.repeat(63) } },
    { label: 'noncanonical digest text', update: { copySha256: 'A'.repeat(64) } },
    { label: 'absent copy extent', update: { copyBytes: null } },
    { label: 'extent smaller than a SQLite page', update: { copyBytes: 4095 } },
    { label: 'noninteger copy extent', update: { copyBytes: 4096.5 } }
  ])('refuses completed-copy $label', async ({ update }) => {
    await db('profile').insert({ ...ready, ...update })
    await expect(readRow(db)).rejects.toThrow('Published profile copy receipt differs')
  })
})
