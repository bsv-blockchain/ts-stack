import knexFactory from 'knex'
import { KnexMigrations, SYNC_TRANSFER_MIGRATION } from '../schema/KnexMigrations'
import { KnexSyncTransferStore } from './KnexSyncTransferStore'
import {
  encodeSyncTransfer,
  receiveSyncTransfer,
  syncTransferDigest,
  decodeSyncTransfer,
  validateSyncTransferCapabilities,
  validateSyncTransferManifest
} from './SyncTransfer'

const capabilities = { version: 1 as const, partBytes: 1024, maxBytes: 1024 * 1024 }

describe('bounded durable sync transport', () => {
  const knex = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  let store: KnexSyncTransferStore
  beforeAll(async () => {
    await (
      await new KnexMigrations('test', 'synthetic', 'a'.repeat(64), 100).getMigration(SYNC_TRANSFER_MIGRATION)
    ).up(knex)
  })
  beforeEach(async () => {
    await knex('sync_transfer_parts').delete()
    await knex('sync_transfers').where('slot', '>', 0).update({ expiresAt: 0 })
    store = new KnexSyncTransferStore(knex, capabilities)
  })
  afterAll(async () => {
    await knex.destroy()
  })

  test('migration replay preserves staging and rollback preserves unrelated wallet data', async () => {
    const migration = await new KnexMigrations('test', 'synthetic', 'a'.repeat(64), 100).getMigration(
      SYNC_TRANSFER_MIGRATION
    )
    await knex.schema.createTable('wallet_rollback_sentinel', table => {
      table.integer('value')
    })
    await knex('wallet_rollback_sentinel').insert({ value: 123 })
    const bytes = encodeSyncTransfer({ data: 'record' })
    const m = await store.beginRead('alice', syncTransferDigest(bytes), bytes)
    await migration.up(knex)
    expect(await receiveSyncTransfer(m, offset => store.read('alice', m.transferId, offset))).toEqual({
      data: 'record'
    })
    await migration.down!(knex)
    expect(await knex('wallet_rollback_sentinel')).toEqual([{ value: 123 }])
    expect(await knex.schema.hasTable('sync_transfers')).toBe(false)
    await migration.up(knex)
    expect(await knex('sync_transfers')).toHaveLength(9)
    await knex.schema.dropTable('wallet_rollback_sentinel')
  })

  test('reads an immutable snapshot in bounded parts and verifies its full bytes', async () => {
    const value = { metadata: 'synthetic', bytes: new Uint8Array(10_000).fill(123) }
    const bytes = encodeSyncTransfer(value)
    const m = await store.beginRead('alice', syncTransferDigest(bytes), bytes)
    const read = jest.fn(offset => store.read('alice', m.transferId, offset))
    expect(await receiveSyncTransfer(m, read)).toEqual(value)
    expect(read.mock.calls.length).toBeGreaterThan(1)
    await expect(store.read('bob', m.transferId, 0)).rejects.toThrow('expired')
    await expect(store.read('alice', m.transferId, 1)).rejects.toThrow('offset')
    await store.release('alice', m.transferId)
    expect(await knex('sync_transfer_parts')).toHaveLength(0)
  })

  test('resumes staged uploads after reopening the store and tolerates identical lost acknowledgements', async () => {
    const bytes = encodeSyncTransfer({ bytes: new Uint8Array(3000).fill(231) })
    const m = await store.beginWrite('alice', syncTransferDigest(bytes), bytes.length)
    const part = bytes.subarray(0, capabilities.partBytes)
    expect(await store.write('alice', m.transferId, 0, part)).toBe(part.length)
    store = new KnexSyncTransferStore(knex, capabilities)
    const resumed = await store.beginWrite('alice', syncTransferDigest(bytes), bytes.length)
    expect(resumed.transferId).toBe(m.transferId)
    expect(resumed.receivedBytes).toBe(part.length)
    expect(await store.write('alice', m.transferId, 0, part)).toBe(part.length)
    await expect(store.write('alice', m.transferId, 0, new Uint8Array(part.length))).rejects.toThrow('replay differs')
    await expect(store.loadWrite('alice', m.transferId)).rejects.toThrow('incomplete')
    for (let offset = part.length; offset < bytes.length; offset += capabilities.partBytes) {
      await store.write('alice', m.transferId, offset, bytes.subarray(offset, offset + capabilities.partBytes))
    }
    expect((await store.loadWrite('alice', m.transferId)).bytes).toEqual(bytes)
    await store.complete('alice', m.transferId, { done: false, inserts: 1 })
    expect((await store.loadWrite('alice', m.transferId)).result).toEqual({ done: false, inserts: 1 })
    expect(await knex('sync_transfer_parts')).toHaveLength(0)
  })

  test('rejects changed upload metadata and invalid part size', async () => {
    const bytes = encodeSyncTransfer({ bytes: new Uint8Array(3000).fill(1) })
    const digest = syncTransferDigest(bytes)
    const m = await store.beginWrite('alice', digest, bytes.length)
    await expect(store.beginWrite('alice', digest, bytes.length + 1)).rejects.toThrow('metadata changed')
    await expect(store.write('alice', m.transferId, 0, bytes.subarray(0, 1023))).rejects.toThrow(
      'Invalid wallet sync part'
    )
    expect((await store.beginWrite('alice', digest, bytes.length)).receivedBytes).toBe(0)
  })

  test('wallet effects and transfer ACK roll back together and reopen recovers without reapplying', async () => {
    await knex.schema.createTable('sync_atomic_wallet_fixture', table => {
      table.integer('value')
    })
    const bytes = encodeSyncTransfer({ data: 'independent atomic transfer fixture' }),
      digest = syncTransferDigest(bytes),
      manifest = await store.beginWrite('alice', digest, bytes.length)
    try {
      for (let offset = 0; offset < bytes.length; offset += capabilities.partBytes)
        await store.write('alice', manifest.transferId, offset, bytes.subarray(offset, offset + capabilities.partBytes))
      await expect(
        store.commitPreparedWrite('alice', manifest.transferId, digest, async trx => {
          await trx('sync_atomic_wallet_fixture').insert({ value: 1 })
          throw new Error('Independent failure after wallet effects')
        })
      ).rejects.toThrow('after wallet effects')
      expect(await knex('sync_atomic_wallet_fixture')).toEqual([])
      expect((await store.loadWrite('alice', manifest.transferId)).bytes).toEqual(bytes)
      await expect(
        store.commitPreparedWrite('alice', manifest.transferId, digest, async trx => {
          await trx('sync_atomic_wallet_fixture').insert({ value: 2 })
          return { invalidAcknowledgement: 'x'.repeat(65537) }
        })
      ).rejects.toThrow('result budget')
      expect(await knex('sync_atomic_wallet_fixture')).toEqual([])
      const apply = jest.fn(async (trx: typeof knex) => {
        await trx('sync_atomic_wallet_fixture').insert({ value: 3 })
        return { done: false, inserts: 1, nextCheckpoint: { sequence: 1 } }
      })
      const result = await store.commitPreparedWrite('alice', manifest.transferId, digest, apply)
      // Discard the caller's ACK, then reopen the actual destination store.
      store = new KnexSyncTransferStore(knex, capabilities)
      expect(await store.commitPreparedWrite('alice', manifest.transferId, digest, apply)).toEqual(result)
      expect(apply).toHaveBeenCalledTimes(1)
      expect(await knex('sync_atomic_wallet_fixture')).toEqual([{ value: 3 }])
      expect(await knex('sync_transfer_parts')).toEqual([])
      await expect(store.commitPreparedWrite('bob', manifest.transferId, digest, apply)).rejects.toThrow('expired')
      await expect(store.commitPreparedWrite('alice', manifest.transferId, 'f'.repeat(64), apply)).rejects.toThrow(
        'current staging'
      )
      expect(apply).toHaveBeenCalledTimes(1)
    } finally {
      await knex.schema.dropTable('sync_atomic_wallet_fixture')
    }
  })

  test('rejects corrupted and out-of-order parts without accepting a complete record', async () => {
    const bytes = encodeSyncTransfer({ bytes: new Uint8Array(2000).fill(53) })
    const m = await store.beginWrite('alice', syncTransferDigest(bytes), bytes.length)
    await expect(store.write('alice', m.transferId, 1024, bytes.subarray(1024, 2048))).rejects.toThrow('out of order')
    for (let offset = 0; offset < bytes.length; offset += capabilities.partBytes) {
      await store.write('alice', m.transferId, offset, bytes.subarray(offset, offset + capabilities.partBytes))
    }
    await knex('sync_transfer_parts')
      .where({ offset: 0 })
      .update({ bytes: Buffer.alloc(1024) })
    await expect(store.loadWrite('alice', m.transferId)).rejects.toThrow('integrity')
  })

  test('bounds per-wallet and global staging and reclaims expired data', async () => {
    const bytes = encodeSyncTransfer({ a: 1 })
    for (let i = 0; i < 8; i++) await store.beginWrite(String(Math.floor(i / 2)), String(i).repeat(64), bytes.length)
    await expect(store.beginWrite('0', 'a'.repeat(64), bytes.length)).rejects.toThrow('Two wallet')
    await expect(store.beginWrite('another', 'a'.repeat(64), bytes.length)).rejects.toThrow('capacity')
    await knex('sync_transfers').where('slot', '>', 0).update({ expiresAt: 0 })
    await expect(store.beginWrite('another', 'a'.repeat(64), bytes.length)).resolves.toMatchObject({ receivedBytes: 0 })
    await expect(store.beginWrite('other', 'a'.repeat(64), capabilities.maxBytes + 1)).rejects.toThrow('size')
  })

  test('binary framing preserves bytes, dates and reserved metadata without expanding raw data', () => {
    const value = {
      when: new Date('2026-01-01T00:00:00.000Z'),
      bytes: new Uint8Array(10_000).fill(255),
      marker: { $bsvBinary: 'base64', data: 'AAAA' }
    }
    const frame = encodeSyncTransfer(value)
    expect(frame.length).toBeLessThan(10_500)
    expect(decodeSyncTransfer(frame)).toEqual({ ...value, when: value.when.toISOString() })
    expect(() => decodeSyncTransfer(frame.subarray(0, frame.length - 1))).toThrow('frame')
    const badHeader = frame.slice()
    new DataView(badHeader.buffer).setUint32(0, frame.length + 1)
    expect(() => decodeSyncTransfer(badHeader)).toThrow('frame')
    expect(() => decodeSyncTransfer(new Uint8Array(3))).toThrow('frame')
  })

  test('framing restores reserved own binary properties and numeric array indices without prototype effects', () => {
    const names = ['__proto__', 'constructor', 'prototype']
    const before = Object.getOwnPropertyDescriptors(Object.prototype)
    const value = Object.fromEntries(names.map((name, index) => [name, new Uint8Array([31 + index])]))
    const restored = decodeSyncTransfer(encodeSyncTransfer({ value, nested: [new Uint8Array([44])] })) as {
      value: Record<string, Uint8Array>
      nested: Uint8Array[]
    }
    expect(Object.getPrototypeOf(restored.value)).toBe(Object.prototype)
    for (const [index, name] of names.entries()) {
      expect(Object.hasOwn(restored.value, name)).toBe(true)
      expect(Object.getOwnPropertyDescriptor(restored.value, name)).toEqual({
        value: new Uint8Array([31 + index]),
        enumerable: true,
        configurable: true,
        writable: true
      })
    }
    expect(restored.nested).toEqual([new Uint8Array([44])])
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before)
  })

  test('rejects malformed field paths, duplicate fields and trailing bytes', () => {
    const frame = (fields: unknown[], value: unknown = { bytes: null }): Uint8Array => {
      const header = new TextEncoder().encode(JSON.stringify({ version: 1, value, fields }))
      const bytes = new Uint8Array(4 + header.length + 1)
      new DataView(bytes.buffer).setUint32(0, header.length)
      bytes.set(header, 4)
      return bytes
    }
    for (const path of [['missing'], ['__proto__', 'polluted'], [-1], ['bytes', 'deep']]) {
      expect(() => decodeSyncTransfer(frame([{ path, length: 1 }]))).toThrow('frame')
    }
    expect(() =>
      decodeSyncTransfer(
        frame([
          { path: ['bytes'], length: 1 },
          { path: ['bytes'], length: 0 }
        ])
      )
    ).toThrow('frame')
    expect(() => decodeSyncTransfer(frame([{ path: ['bytes'], length: 0 }]))).toThrow('frame')
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
  })

  test('an interrupted snapshot build can resume without changing a published snapshot', async () => {
    const bytes = encodeSyncTransfer({ bytes: new Uint8Array(2000).fill(61) })
    const context = syncTransferDigest(bytes)
    const first = await store.beginRead('alice', context, bytes)
    const changed = encodeSyncTransfer({ bytes: new Uint8Array(2000).fill(62) })
    expect(await store.beginRead('alice', context, changed)).toEqual(first)
    await knex('sync_transfers').where({ transferId: first.transferId }).update({ state: 'building' })
    await knex('sync_transfer_parts').delete()
    const rebuilt = await store.beginRead('alice', context, changed)
    expect(await receiveSyncTransfer(rebuilt, offset => store.read('alice', rebuilt.transferId, offset))).toEqual({
      bytes: new Uint8Array(2000).fill(62)
    })
  })

  test('rejects invalid advertised limits and corrupted download parts', async () => {
    expect(() => validateSyncTransferCapabilities({ ...capabilities, maxBytes: Infinity })).toThrow('capabilities')
    const bytes = encodeSyncTransfer({ data: 'z'.repeat(4000) })
    const m = await store.beginRead('alice', syncTransferDigest(bytes), bytes)
    expect(validateSyncTransferManifest(m, capabilities)).toEqual(m)
    expect(() => validateSyncTransferManifest({ ...m, totalBytes: -1 }, capabilities)).toThrow('manifest')
    await expect(
      receiveSyncTransfer(m, async offset => ({ offset, bytes: new Uint8Array(Math.min(1024, bytes.length - offset)) }))
    ).rejects.toThrow('integrity')
    await expect(receiveSyncTransfer(m, async () => ({ offset: 1, bytes: new Uint8Array(1024) }))).rejects.toThrow(
      'part'
    )
  })
})
