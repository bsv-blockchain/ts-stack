import type { Knex } from 'knex'
import { randomBytes } from 'node:crypto'
import {
  type SyncTransferCapabilities, type SyncTransferManifest, type SyncTransferPart,
  syncTransferDigest
} from './SyncTransfer'

const TTL_MS = 15 * 60 * 1000
interface TransferRow {
  slot: number
  transferId: string
  identityKey: string
  context: string
  direction: 'read' | 'write'
  digest: string
  totalBytes: number
  receivedBytes: number
  partBytes: number
  expiresAt: number
  state: 'building' | 'ready' | 'complete'
  result: string | null
}

/** Durable, identity-scoped staging in the wallet database; never part of exported wallet data. */
export class KnexSyncTransferStore {
  constructor(private readonly knex: Knex, readonly capabilities: SyncTransferCapabilities) {}

  private async locked<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return await this.knex.transaction(async trx => {
      // A write takes the SQLite lock as well as the MySQL row lock before reading quotas.
      const locked = await trx('sync_transfers').where({ slot: 0 }).update({ expiresAt: 0 })
      if (locked !== 1) throw new Error('Wallet sync transfer migration is required')
      return await work(trx)
    })
  }

  private manifest(row: TransferRow): SyncTransferManifest {
    return { transferId: row.transferId, digest: row.digest, totalBytes: Number(row.totalBytes),
      partBytes: Number(row.partBytes), expiresAt: Number(row.expiresAt) }
  }

  private async row(trx: Knex.Transaction, identityKey: string, transferId: string): Promise<TransferRow> {
    if (!/^[a-f0-9]{64}$/.test(transferId)) throw new TypeError('Invalid sync transfer identifier')
    const row = await trx<TransferRow>('sync_transfers').where({ identityKey, transferId }).first()
    if (row == null || Number(row.expiresAt) <= Date.now()) throw new Error('Wallet sync transfer expired; resume from the saved wallet checkpoint')
    return row
  }

  private async clear(trx: Knex.Transaction, slot: number): Promise<void> {
    await trx('sync_transfer_parts').where({ slot }).delete()
    await trx('sync_transfers').where({ slot }).update({ transferId: null, identityKey: null, context: null,
      direction: null, digest: null, totalBytes: null, partBytes: null, receivedBytes: 0,
      expiresAt: 0, state: null, result: null })
  }

  private async allocate(identityKey: string, context: string, direction: 'read' | 'write',
    totalBytes: number, digest: string): Promise<{ row: TransferRow; created: boolean }> {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > this.capabilities.maxBytes ||
      !/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{64}$/.test(context)) {
      throw new RangeError('Wallet sync transfer exceeds the negotiated size or has invalid integrity metadata')
    }
    return await this.locked(async trx => {
      const expired = await trx<TransferRow>('sync_transfers').where('slot', '>', 0).whereNotNull('transferId').where('expiresAt', '<=', Date.now())
      for (const row of expired) await this.clear(trx, row.slot)
      const existing = await trx<TransferRow>('sync_transfers').where({ identityKey, context, direction }).first()
      if (existing != null) return { row: existing, created: false }
      const owned = await trx<TransferRow>('sync_transfers').where({ identityKey })
      if (owned.length >= 2) throw new Error('Two wallet sync transfers are already pending; resume them or wait for their expiry')
      const available = await trx<TransferRow>('sync_transfers').where('slot', '>', 0).whereNull('transferId').orderBy('slot').first()
      if (available == null) throw new Error('Wallet sync transfer capacity is busy; retry later')
      const row: TransferRow = { slot: available.slot, transferId: randomBytes(32).toString('hex'), identityKey,
        context, direction, digest, totalBytes, receivedBytes: 0, partBytes: this.capabilities.partBytes,
        expiresAt: Date.now() + TTL_MS, state: direction === 'read' ? 'building' : 'ready', result: null }
      await trx('sync_transfers').where({ slot: row.slot }).update(row)
      return { row, created: true }
    })
  }

  async beginRead(identityKey: string, context: string, bytes: Uint8Array): Promise<SyncTransferManifest> {
    const { row, created } = await this.allocate(identityKey, context, 'read', bytes.length, syncTransferDigest(bytes))
    if (!created && row.state === 'ready') return this.manifest(row)
    return await this.locked(async trx => {
      const saved = await this.row(trx, identityKey, row.transferId)
      if (saved.state === 'ready') return this.manifest(saved)
      await trx('sync_transfer_parts').where({ slot: row.slot }).delete()
      for (let offset = 0; offset < bytes.length; offset += row.partBytes) {
        await trx('sync_transfer_parts').insert({ slot: row.slot, offset,
          bytes: Buffer.from(bytes.subarray(offset, offset + row.partBytes)) })
      }
      const ready = { ...saved, state: 'ready' as const, digest: syncTransferDigest(bytes),
        totalBytes: bytes.length, receivedBytes: bytes.length }
      await trx('sync_transfers').where({ slot: row.slot }).update(ready)
      return this.manifest(ready)
    })
  }

  async beginWrite(identityKey: string, digest: string, totalBytes: number): Promise<SyncTransferManifest & { receivedBytes: number }> {
    const { row } = await this.allocate(identityKey, digest, 'write', totalBytes, digest)
    if (Number(row.totalBytes) !== totalBytes || row.digest !== digest) throw new Error('Wallet sync transfer metadata changed')
    return { ...this.manifest(row), receivedBytes: Number(row.receivedBytes) }
  }

  async read(identityKey: string, transferId: string, offset: number): Promise<SyncTransferPart> {
    return await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      if (row.direction !== 'read' || row.state !== 'ready' || !Number.isSafeInteger(offset) || offset < 0 ||
        offset >= row.totalBytes || offset % row.partBytes !== 0) throw new TypeError('Invalid wallet sync part offset')
      const part = await trx<{ slot: number; offset: number; bytes: Buffer }>('sync_transfer_parts').where({ slot: row.slot, offset }).first()
      if (part == null) throw new Error('Wallet sync transfer part is missing')
      return { offset, bytes: new Uint8Array(part.bytes) }
    })
  }

  async write(identityKey: string, transferId: string, offset: number, bytes: Uint8Array): Promise<number> {
    return await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      if (row.direction !== 'write' || row.state !== 'ready' || !Number.isSafeInteger(offset) || offset < 0 ||
        offset % row.partBytes !== 0 || !(bytes instanceof Uint8Array) ||
        bytes.length !== Math.min(row.partBytes, row.totalBytes - offset)) throw new TypeError('Invalid wallet sync part')
      if (offset < row.receivedBytes) {
        const prior = await trx<{ slot: number; offset: number; bytes: Buffer }>('sync_transfer_parts').where({ slot: row.slot, offset }).first()
        if (prior == null || !Buffer.from(bytes).equals(prior.bytes)) throw new Error('Wallet sync part replay differs from saved bytes')
        return Number(row.receivedBytes)
      }
      if (offset !== Number(row.receivedBytes)) throw new Error('Wallet sync part is out of order')
      await trx('sync_transfer_parts').insert({ slot: row.slot, offset, bytes: Buffer.from(bytes) })
      const receivedBytes = offset + bytes.length
      await trx('sync_transfers').where({ slot: row.slot }).update({ receivedBytes })
      return receivedBytes
    })
  }

  async loadWrite(identityKey: string, transferId: string): Promise<{ bytes: Uint8Array; result?: unknown }> {
    return await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      if (row.direction !== 'write' || Number(row.receivedBytes) !== Number(row.totalBytes)) throw new Error('Wallet sync transfer is incomplete')
      if (row.state === 'complete') return { bytes: new Uint8Array(), result: JSON.parse(row.result!) }
      const parts = await trx<{ slot: number; offset: number; bytes: Buffer }>('sync_transfer_parts').where({ slot: row.slot }).orderBy('offset')
      const bytes = new Uint8Array(Number(row.totalBytes))
      let offset = 0
      for (const part of parts) {
        if (part.offset !== offset) throw new Error('Wallet sync transfer part is missing')
        bytes.set(part.bytes, offset)
        offset += part.bytes.length
      }
      if (offset !== bytes.length || syncTransferDigest(bytes) !== row.digest) throw new Error('Wallet sync transfer integrity check failed')
      return { bytes }
    })
  }

  async complete(identityKey: string, transferId: string, result: unknown): Promise<void> {
    await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      await trx('sync_transfers').where({ slot: row.slot }).update({ state: 'complete', result: JSON.stringify(result) })
      await trx('sync_transfer_parts').where({ slot: row.slot }).delete()
    })
  }

  async release(identityKey: string, transferId: string): Promise<void> {
    await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      await this.clear(trx, row.slot)
    })
  }
}
