import { collectBrc38NativePackedContent } from '../portable/Brc38NativePackedTextFieldsNode'
import {
  withBrc38NativeLocalPackedWalletMutation,
  withBrc38NativeLocalPackedWalletTransaction,
  prepareBrc38NativeLocalPackedWalletWrite,
  finishBrc38NativeLocalPackedWalletWrite,
  releaseBrc38NativeLocalPackedWalletWrite,
  hydrateBrc38NativeLocalPackedWalletRows,
  readBrc38NativeLocalPackedBinaryPacket
} from '../portable/Brc38NativeLocalPackedWalletNode'
import type { Knex } from 'knex'
import { randomBytes } from 'node:crypto'
import {
  type SyncTransferCapabilities,
  type SyncTransferManifest,
  type SyncTransferPart,
  syncTransferDigest
} from './SyncTransfer'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'

// Membership is issued only by this store's actual root transaction and
// removed after its work/drain settles. Caller metadata cannot register it.
const transferTransactions = new WeakMap<Knex.Transaction, Knex>()
export function requireSyncTransferTransaction(transaction: Knex.Transaction, original: Knex): void {
  if (transferTransactions.get(transaction) !== original)
    throw new WERR_INVALID_OPERATION('Snapshot transfer commit requires its actual original SQL transaction')
}

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
  constructor(
    private readonly knex: Knex,
    readonly capabilities: SyncTransferCapabilities
  ) {}

  private async locked<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return await this.knex.transaction(async trx => {
      // A write takes the SQLite lock as well as the MySQL row lock before reading quotas.
      const locked = await trx('sync_transfers').where({ slot: 0 }).update({ expiresAt: 0 })
      if (locked !== 1) throw new Error('Wallet sync transfer migration is required')
      transferTransactions.set(trx, this.knex)
      try {
        const result = await work(trx)
        await withBrc38NativeLocalPackedWalletTransaction(trx, async (db, packed) => {
          if (packed) await collectBrc38NativePackedContent(db as Knex.Transaction, 16)
        })
        return result
      } finally {
        transferTransactions.delete(trx)
      }
    })
  }

  private async insertPart(trx: Knex.Transaction, slot: number, offset: number, bytes: Uint8Array): Promise<void> {
    await withBrc38NativeLocalPackedWalletMutation(trx, async (db, packed) => {
      const prepared = packed
        ? prepareBrc38NativeLocalPackedWalletWrite('sync_transfer_parts', { slot, offset, bytes })
        : undefined
      try {
        await db('sync_transfer_parts').insert(prepared?.row ?? { slot, offset, bytes: Buffer.from(bytes) })
        if (prepared !== undefined) {
          const rows = (await db('sync_transfer_parts')
            .where({ slot, offset })
            .select(db.raw('rowid AS physicalRowId'))
            .limit(2)) as Array<{ physicalRowId: number }>
          if (rows.length !== 1) throw new Error('Wallet sync transfer part lost its actual physical row')
          await finishBrc38NativeLocalPackedWalletWrite(
            db as Knex.Transaction,
            'sync_transfer_parts',
            rows[0].physicalRowId,
            prepared.fields
          )
        }
      } finally {
        if (prepared !== undefined) releaseBrc38NativeLocalPackedWalletWrite(prepared)
      }
    })
  }

  private async readPart(
    trx: Knex.Transaction,
    slot: number,
    offset: number,
    maximumBytes: number
  ): Promise<Buffer | undefined> {
    return await withBrc38NativeLocalPackedWalletTransaction(trx, async (db, packed) => {
      if (!packed) {
        // Evaluate the stored length before fetching the BLOB. A changed row
        // cannot allocate beyond the original part reservation.
        const rows = await db<{ slot: number; offset: number; bytes: Buffer }>('sync_transfer_parts')
          .where({ slot, offset })
          .whereRaw('length(??) BETWEEN 1 AND ?', ['bytes', maximumBytes])
          .select('bytes')
          .limit(2)
        if (rows.length > 1) throw new Error('Wallet sync transfer has duplicate part coordinates')
        return rows[0]?.bytes
      }
      const rows = (await db('sync_transfer_parts')
        .where({ slot, offset })
        .select(db.raw('rowid AS physicalRowId'))
        .limit(2)) as Array<{ physicalRowId: number }>
      if (rows.length === 0) return undefined
      if (rows.length !== 1) throw new Error('Wallet sync transfer has duplicate actual part coordinates')
      const bytes = await readBrc38NativeLocalPackedBinaryPacket(
        db as Knex.Transaction,
        'sync_transfer_parts',
        rows[0].physicalRowId,
        maximumBytes
      )
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    })
  }

  private async saveResult(
    trx: Knex.Transaction,
    where: Readonly<Record<string, string | number>>,
    update: Readonly<Record<string, unknown>>
  ): Promise<number> {
    return await withBrc38NativeLocalPackedWalletMutation(trx, async (db, packed) => {
      const prepared = packed ? prepareBrc38NativeLocalPackedWalletWrite('sync_transfers', update) : undefined
      try {
        const result = await db('sync_transfers')
          .where(where)
          .update(prepared?.row ?? update)
        if (result !== 0 && prepared !== undefined)
          await finishBrc38NativeLocalPackedWalletWrite(
            db as Knex.Transaction,
            'sync_transfers',
            Number(where.slot),
            prepared.fields
          )
        return result
      } finally {
        if (prepared !== undefined) releaseBrc38NativeLocalPackedWalletWrite(prepared)
      }
    })
  }

  private manifest(row: TransferRow): SyncTransferManifest {
    return {
      transferId: row.transferId,
      digest: row.digest,
      totalBytes: Number(row.totalBytes),
      partBytes: Number(row.partBytes),
      expiresAt: Number(row.expiresAt)
    }
  }

  private async row(trx: Knex.Transaction, identityKey: string, transferId: string): Promise<TransferRow> {
    if (!/^[a-f0-9]{64}$/.test(transferId)) throw new TypeError('Invalid sync transfer identifier')
    const row = await trx<TransferRow>('sync_transfers').where({ identityKey, transferId }).first()
    if (row == null || Number(row.expiresAt) <= Date.now())
      throw new WERR_INVALID_OPERATION('Wallet sync transfer expired; resume from the saved wallet checkpoint')
    if (
      !Number.isSafeInteger(Number(row.totalBytes)) ||
      Number(row.totalBytes) < 1 ||
      Number(row.totalBytes) > this.capabilities.maxBytes ||
      Number(row.partBytes) !== this.capabilities.partBytes
    )
      throw new WERR_INVALID_OPERATION('Wallet sync transfer exceeds its current negotiated allocation')
    await withBrc38NativeLocalPackedWalletTransaction(trx, async (db, packed) => {
      if (packed) await hydrateBrc38NativeLocalPackedWalletRows(db as Knex.Transaction, 'sync_transfers', [row])
    })
    return row
  }

  private async clear(trx: Knex.Transaction, slot: number): Promise<void> {
    await trx('sync_transfer_parts').where({ slot }).delete()
    await trx('sync_transfers').where({ slot }).update({
      transferId: null,
      identityKey: null,
      context: null,
      direction: null,
      digest: null,
      totalBytes: null,
      partBytes: null,
      receivedBytes: 0,
      expiresAt: 0,
      state: null,
      result: null
    })
  }

  private async allocate(
    identityKey: string,
    context: string,
    direction: 'read' | 'write',
    totalBytes: number,
    digest: string,
    originalExpiresAt?: number
  ): Promise<{ row: TransferRow; created: boolean }> {
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 1 ||
      totalBytes > this.capabilities.maxBytes ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !/^[a-f0-9]{64}$/.test(context)
    ) {
      throw new RangeError('Wallet sync transfer exceeds the negotiated size or has invalid integrity metadata')
    }
    if (
      originalExpiresAt !== undefined &&
      (!Number.isSafeInteger(originalExpiresAt) ||
        originalExpiresAt <= Date.now() ||
        originalExpiresAt > Date.now() + 3600000)
    )
      throw new WERR_INVALID_OPERATION('Wallet sync transfer original expiry differs')
    return await this.locked(async trx => {
      const expired = await trx<TransferRow>('sync_transfers')
        .where('slot', '>', 0)
        .whereNotNull('transferId')
        .where('expiresAt', '<=', Date.now())
      for (const row of expired) await this.clear(trx, row.slot)
      const existing = await trx<TransferRow>('sync_transfers').where({ identityKey, context, direction }).first()
      if (existing != null) {
        if (originalExpiresAt !== undefined && Number(existing.expiresAt) > originalExpiresAt)
          throw new WERR_INVALID_OPERATION('Wallet sync transfer original expiry changed')
        return { row: existing, created: false }
      }
      const owned = await trx<TransferRow>('sync_transfers').where({ identityKey })
      if (owned.length >= 2)
        throw new Error('Two wallet sync transfers are already pending; resume them or wait for their expiry')
      const available = await trx<TransferRow>('sync_transfers')
        .where('slot', '>', 0)
        .whereNull('transferId')
        .orderBy('slot')
        .first()
      if (available == null) throw new Error('Wallet sync transfer capacity is busy; retry later')
      const row: TransferRow = {
        slot: available.slot,
        transferId: randomBytes(32).toString('hex'),
        identityKey,
        context,
        direction,
        digest,
        totalBytes,
        receivedBytes: 0,
        partBytes: this.capabilities.partBytes,
        expiresAt: Math.min(originalExpiresAt ?? Infinity, Date.now() + TTL_MS),
        state: direction === 'read' ? 'building' : 'ready',
        result: null
      }
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
        await this.insertPart(trx, row.slot, offset, bytes.subarray(offset, offset + row.partBytes))
      }
      const ready = {
        ...saved,
        state: 'ready' as const,
        digest: syncTransferDigest(bytes),
        totalBytes: bytes.length,
        receivedBytes: bytes.length
      }
      await this.saveResult(trx, { slot: row.slot }, ready)
      return this.manifest(ready)
    })
  }

  async beginWrite(
    identityKey: string,
    digest: string,
    totalBytes: number,
    originalExpiresAt?: number,
    context: string = digest
  ): Promise<SyncTransferManifest & { receivedBytes: number }> {
    const { row } = await this.allocate(identityKey, context, 'write', totalBytes, digest, originalExpiresAt)
    if (Number(row.totalBytes) !== totalBytes || row.digest !== digest)
      throw new Error('Wallet sync transfer metadata changed')
    return { ...this.manifest(row), receivedBytes: Number(row.receivedBytes) }
  }

  async read(identityKey: string, transferId: string, offset: number): Promise<SyncTransferPart> {
    return await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      if (
        row.direction !== 'read' ||
        row.state !== 'ready' ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= row.totalBytes ||
        offset % row.partBytes !== 0
      )
        throw new TypeError('Invalid wallet sync part offset')
      const part = await this.readPart(trx, row.slot, offset, Number(row.partBytes))
      if (part == null) throw new Error('Wallet sync transfer part is missing')
      try {
        return { offset, bytes: new Uint8Array(part) }
      } finally {
        part.fill(0)
      }
    })
  }

  async write(
    identityKey: string,
    transferId: string,
    offset: number,
    bytes: Uint8Array,
    expectedContext?: string
  ): Promise<number> {
    return await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      if (expectedContext !== undefined && row.context !== expectedContext)
        throw new WERR_INVALID_OPERATION('Wallet sync transfer differs from its actual protocol owner')
      if (
        row.direction !== 'write' ||
        row.state !== 'ready' ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset % row.partBytes !== 0 ||
        !(bytes instanceof Uint8Array) ||
        bytes.length !== Math.min(row.partBytes, row.totalBytes - offset)
      )
        throw new TypeError('Invalid wallet sync part')
      if (offset < row.receivedBytes) {
        const prior = await this.readPart(trx, row.slot, offset, Number(row.partBytes))
        try {
          if (prior == null || !Buffer.from(bytes).equals(prior))
            throw new Error('Wallet sync part replay differs from saved bytes')
          return Number(row.receivedBytes)
        } finally {
          prior?.fill(0)
        }
      }
      if (offset !== Number(row.receivedBytes)) throw new Error('Wallet sync part is out of order')
      await this.insertPart(trx, row.slot, offset, bytes)
      const receivedBytes = offset + bytes.length
      await trx('sync_transfers').where({ slot: row.slot }).update({ receivedBytes })
      return receivedBytes
    })
  }

  async loadWrite(
    identityKey: string,
    transferId: string,
    expectedContext?: string
  ): Promise<{ bytes: Uint8Array; result?: unknown }> {
    return await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      if (expectedContext !== undefined && row.context !== expectedContext)
        throw new WERR_INVALID_OPERATION('Wallet sync transfer differs from its actual protocol owner')
      if (row.direction !== 'write' || Number(row.receivedBytes) !== Number(row.totalBytes))
        throw new Error('Wallet sync transfer is incomplete')
      if (row.state === 'complete') return { bytes: new Uint8Array(), result: JSON.parse(row.result!) }
      const parts = await trx<{ slot: number; offset: number }>('sync_transfer_parts')
        .where({ slot: row.slot })
        .select('offset')
        .orderBy('offset')
        .limit(Math.ceil(this.capabilities.maxBytes / this.capabilities.partBytes) + 1)
      if (parts.length !== Math.ceil(Number(row.totalBytes) / Number(row.partBytes)))
        throw new Error('Wallet sync transfer has an invalid bounded part count')
      const bytes = new Uint8Array(Number(row.totalBytes))
      let offset = 0
      for (const part of parts) {
        if (part.offset !== offset) throw new Error('Wallet sync transfer part is missing')
        const packet = await this.readPart(trx, row.slot, part.offset, Number(row.partBytes))
        if (packet === undefined) throw new Error('Wallet sync transfer part is missing')
        try {
          bytes.set(packet, offset)
          offset += packet.length
        } finally {
          packet.fill(0)
        }
      }
      if (offset !== bytes.length || syncTransferDigest(bytes) !== row.digest)
        throw new Error('Wallet sync transfer integrity check failed')
      return { bytes }
    })
  }

  async complete(identityKey: string, transferId: string, result: unknown): Promise<void> {
    await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      await this.saveResult(trx, { slot: row.slot }, { state: 'complete', result: JSON.stringify(result) })
      await trx('sync_transfer_parts').where({ slot: row.slot }).delete()
    })
  }

  /** Proof/authentication and bounded payload preparation precede this call.
   * The actual wallet merge/checkpoint and its recoverable transfer result use
   * ONE native transaction. A competing/lost ACK replay reads the saved result
   * without consuming the one-use prepared merge. No sender cursor is authority. */
  async commitPreparedWrite<T>(
    identityKey: string,
    transferId: string,
    digest: string,
    apply: (trx: Knex.Transaction) => Promise<T>
  ): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('Invalid sync transfer digest')
    return await this.locked(async trx => {
      const row = await this.row(trx, identityKey, transferId)
      if (row.direction !== 'write' || Number(row.receivedBytes) !== Number(row.totalBytes) || row.digest !== digest)
        throw new WERR_INVALID_OPERATION('Prepared wallet sync transfer differs from its current staging')
      if (row.state === 'complete') {
        if (row.result === null)
          throw new WERR_INVALID_OPERATION('Completed wallet sync transfer has no durable result')
        return JSON.parse(row.result) as T
      }
      if (row.state !== 'ready') throw new WERR_INVALID_OPERATION('Prepared wallet sync transfer is not ready')
      const result = await apply(trx),
        json = JSON.stringify(result)
      if (typeof json !== 'string' || Buffer.byteLength(json) > 65536)
        throw new WERR_INVALID_OPERATION('Wallet sync acknowledgement exceeds its bounded result budget')
      // The source remains under its original TTL through the whole commit.
      if (Number(row.expiresAt) <= Date.now())
        throw new WERR_INVALID_OPERATION('Wallet sync transfer expired before atomic acknowledgement')
      const changed = await this.saveResult(
        trx,
        { slot: row.slot, transferId, identityKey, digest, state: 'ready' },
        { state: 'complete', result: json }
      )
      if (changed !== 1) throw new WERR_INVALID_OPERATION('Wallet sync transfer changed before atomic acknowledgement')
      await trx('sync_transfer_parts').where({ slot: row.slot }).delete()
      return result
    })
  }

  async release(identityKey: string, transferId: string): Promise<void> {
    await this.locked(async trx => {
      if (!/^[a-f0-9]{64}$/.test(transferId)) throw new TypeError('Invalid sync transfer identifier')
      // Cleanup may run after expiry and is idempotent. Authentication still
      // scopes the actual stored row; no expired transfer may gain write time.
      const row = await trx<TransferRow>('sync_transfers').where({ identityKey, transferId }).first()
      if (row !== undefined) await this.clear(trx, row.slot)
    })
  }
}
