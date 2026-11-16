import fc from 'fast-check'
import createKnex, { type Knex } from 'knex'
import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertBrc38ProfileCreationGrant,
  assertBrc38ProfileRetirementGrant,
  createBrc38ProfileCreationGrant,
  createBrc38ProfileRetirementGrant,
  type Brc38ProfileCreationGrant
} from './Brc38ProfileInventoryClaimNode'
import type { Brc38ProfileInventoryBinding } from './Brc38PublishedProfileNode'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
type Mode = 'creation' | 'retirement'
const make = (mode: Mode) => (mode === 'creation' ? createBrc38ProfileCreationGrant : createBrc38ProfileRetirementGrant)
const check = (mode: Mode) =>
  mode === 'creation' ? assertBrc38ProfileCreationGrant : assertBrc38ProfileRetirementGrant
const state = (mode: Mode) => (mode === 'creation' ? 'reserved' : 'retiring')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const uuid = (prefix: string, value: number) => `${prefix}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
const policyJson = JSON.stringify([2, 12582912]),
  policySha256 = hash(policyJson)
const id = fc.integer({ min: 1, max: 65535 })
const digest = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(bytes => Buffer.from(bytes).toString('hex'))
const mode = fc.constantFrom<Mode>('creation', 'retirement')
const distinct = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1)
function inventory(value: number): Brc38ProfileInventoryBinding {
  return { rootId: uuid('10000000', value), profileId: uuid('20000000', value), policySha256 }
}
function nativeRow(value: Brc38ProfileInventoryBinding, digest: string, mode: Mode) {
  // Fixed metadata is opaque to this leaf. This tests catalog-row authority,
  // not publication, a staged store, a real published profile or activation.
  const fixedJson = JSON.stringify({
    fixture: 'bounded catalog authority leaf',
    inventory: value,
    bindingSha256: digest
  })
  return {
    id: value.profileId,
    importId: value.profileId.replace('20000000', '30000000'),
    bindingSha256: digest,
    expiresAt: 1000000000000,
    maximumPhysicalBytes: 4194304,
    state: state(mode),
    fixedJson,
    fixedSha256: hash(fixedJson)
  }
}
async function fixture(filename = 'profile-inventory.sqlite') {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-property-inventory-claim-'))
  await chmod(directory, 0o700)
  if (process.env.TMPDIR === '/work/fixtures')
    await appendFile(
      '/work/validation/fixture-record.jsonl',
      JSON.stringify({ path: directory, owner: 'inventory-claim-property' }) + '\n'
    )
  const file = await open(join(directory, filename), 'wx', 0o600)
  await file.close()
  const db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, filename) },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
    acquireConnectionTimeout: 1000
  })
  try {
    // The two original catalog tables/keys/index are retained verbatim. No
    // profile/native-engine constructor, schema migration or fault fixture runs.
    await db.schema.createTable('profile_inventory_capacity', table => {
      table.integer('slot').primary()
      table.string('protocol', 32).notNullable()
      table.string('rootId', 36).notNullable()
      table.string('policyJson', 128).notNullable()
      table.string('policySha256', 64).notNullable()
    })
    await db.schema.createTable('profile_inventory', table => {
      table.string('id', 36).primary()
      table.string('importId', 36).notNullable().unique()
      table.string('bindingSha256', 64).notNullable()
      table.bigInteger('expiresAt').notNullable()
      table.bigInteger('maximumPhysicalBytes').notNullable()
      table.string('state', 16).notNullable()
      table.text('fixedJson').notNullable()
      table.string('fixedSha256', 64).notNullable()
      table.index(['state', 'expiresAt', 'id'])
    })
    async function reset(value: Brc38ProfileInventoryBinding, digest: string, mode: Mode, includeRow = true) {
      await db('profile_inventory').delete()
      await db('profile_inventory_capacity').delete()
      await db('profile_inventory_capacity').insert({
        slot: 1,
        protocol: 'brc38-profile-inventory/v1',
        rootId: value.rootId,
        policyJson,
        policySha256
      })
      if (includeRow) await db('profile_inventory').insert(nativeRow(value, digest, mode))
    }
    return {
      directory,
      db,
      reset,
      close: async () => {
        await db.destroy()
        await rm(directory, { recursive: true, force: true })
      }
    }
  } catch (cause) {
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
}

describe('actual inventory transaction grants do not borrow authority from object shape or stale rows', () => {
  test('generated grants detach binding and recheck every selected durable scope field and state', async () => {
    const target = await fixture()
    try {
      await fc.assert(
        fc.asyncProperty(
          id,
          digest,
          mode,
          fc.constantFrom('root', 'policy', 'profile', 'binding', 'state'),
          async (id, digest, mode, changed) => {
            const selected = inventory(id),
              expected = { ...selected },
              row = nativeRow(selected, digest, mode)
            await target.reset(selected, digest, mode)
            await target.db.transaction(async trx => {
              const grant = await make(mode)(trx, target.directory, selected, digest)
              expect(grant).toEqual({
                directory: join(target.directory, expected.profileId),
                bindingSha256: digest,
                inventory: expected
              })
              expect(Object.isFrozen(grant)).toBe(true)
              expect(Object.isFrozen(grant.inventory)).toBe(true)
              expect(grant.inventory).not.toBe(selected)
              ;(selected as { rootId: string }).rootId = uuid('90000000', id)
              await check(mode)(grant)
              await expect(check(mode)({ ...grant, inventory: { ...grant.inventory } })).rejects.toThrow(
                'actual profile inventory'
              )
              await expect(check(mode === 'creation' ? 'retirement' : 'creation')(grant)).rejects.toThrow(
                'actual profile inventory'
              )
              if (changed === 'root')
                await trx('profile_inventory_capacity')
                  .where({ slot: 1 })
                  .update({ rootId: uuid('90000000', id) })
              else if (changed === 'policy')
                await trx('profile_inventory_capacity')
                  .where({ slot: 1 })
                  .update({ policySha256: distinct(policySha256) })
              else if (changed === 'profile')
                await trx('profile_inventory')
                  .where({ id: expected.profileId })
                  .update({ id: uuid('90000000', id) })
              else if (changed === 'binding')
                await trx('profile_inventory')
                  .where({ id: expected.profileId })
                  .update({ bindingSha256: distinct(digest) })
              else await trx('profile_inventory').where({ id: expected.profileId }).update({ state: 'published' })
              await expect(check(mode)(grant)).rejects.toThrow('scope or durable state differs')
              await trx('profile_inventory_capacity')
                .where({ slot: 1 })
                .update({ rootId: expected.rootId, policySha256 })
              await trx('profile_inventory').update(row)
              await check(mode)(grant)
              expect(grant.inventory).toEqual(expected)
              expect((await trx('profile_inventory').first()).bindingSha256).toBe(digest)
            })
          }
        ),
        controls
      )
    } finally {
      await target.close()
    }
  }, 30000)

  test('generated committed and rolled-back reservations never keep a completed writer grant alive', async () => {
    const target = await fixture()
    try {
      await fc.assert(
        fc.asyncProperty(id, digest, mode, fc.boolean(), async (id, digest, mode, commit) => {
          const selected = inventory(id),
            row = nativeRow(selected, digest, mode)
          await target.reset(selected, digest, mode, false)
          const trx = await target.db.transaction()
          let grant: Brc38ProfileCreationGrant | undefined
          try {
            await trx('profile_inventory').insert(row)
            grant = await make(mode)(trx, target.directory, selected, digest)
            await check(mode)(grant)
            if (commit) await trx.commit()
            else await trx.rollback()
          } finally {
            if (!trx.isCompleted()) await trx.rollback()
          }
          if (grant === undefined) throw new Error('Owned generated grant was not created')
          await expect(check(mode)(grant)).rejects.toThrow('writer has completed')
          expect(await target.db('profile_inventory').select('*')).toEqual(commit ? [row] : [])
          await expect(check(mode)({ ...grant })).rejects.toThrow('actual profile inventory')
          if (commit)
            await target.db.transaction(async next => {
              const successor = await make(mode)(next, target.directory, selected, digest)
              expect(successor).not.toBe(grant)
              await check(mode)(successor)
              await expect(check(mode)(grant!)).rejects.toThrow('writer has completed')
            })
        }),
        controls
      )
    } finally {
      await target.close()
    }
  }, 30000)

  test('generated wrong catalog filenames and nontransaction owners reject before any authority query', async () => {
    const target = await fixture('other-owned.sqlite')
    try {
      await fc.assert(
        fc.asyncProperty(id, digest, mode, async (id, digest, mode) => {
          const selected = inventory(id)
          await target.reset(selected, digest, mode)
          await target.db.transaction(async trx => {
            const queries: string[] = []
            trx.on('query', (value: { sql: string }) => queries.push(value.sql))
            await expect(make(mode)(trx, target.directory, selected, digest)).rejects.toThrow(
              'actual native catalog transaction'
            )
            expect(queries).toHaveLength(0)
          })
          const queries: string[] = [],
            capture = (value: { sql: string }) => queries.push(value.sql)
          target.db.on('query', capture)
          try {
            await expect(
              make(mode)(target.db as unknown as Knex.Transaction, target.directory, selected, digest)
            ).rejects.toThrow('actual SQLite transaction')
            expect(queries).toHaveLength(0)
          } finally {
            target.db.removeListener('query', capture)
          }
          expect((await target.db('profile_inventory').first()).state).toBe(state(mode))
        }),
        controls
      )
    } finally {
      await target.close()
    }
  }, 30000)
})
