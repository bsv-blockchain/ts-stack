import { Hash, Random, Utils } from '@bsv/sdk'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import { runInSeries } from '../../../utility/runInSeries'
import { lockSnapshotArchiveCapacity, snapshotArchiveDatabaseNow } from './SnapshotArchiveSql'
import { snapshotArchiveEncoding, type SnapshotArchiveDirectory } from './SnapshotArchiveDirectory'

import {
  snapshotArchiveTables,
  snapshotArchiveLimits,
  type SnapshotArchiveBinding,
  type SnapshotArchiveWriter,
  type SnapshotArchiveManifest,
  type SnapshotArchivePage
} from './SnapshotArchive'
export {
  snapshotArchiveTables,
  snapshotArchiveLimits,
  type SnapshotArchiveBinding,
  type SnapshotArchiveWriter,
  type SnapshotArchiveManifest,
  type SnapshotArchivePage
} from './SnapshotArchive'

interface ArchiveRow {
  archiveId: string
  identityKey: string
  writerToken: string
  state: 'building' | 'ready' | 'closing'
  binding: string
  expiresAt: number | string
  reservedBytes: number | string
  usedBytes: number | string
  nextSequence: number
  tableIndex: number
  rows: number | string
  digest: string
}

interface PageRow {
  archiveId: string
  sequence: number
  tableName: WalletSnapshotTable
  rows: number
  done: number | boolean
  payload: Uint8Array
  digest: string
}

function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WERR_INVALID_PARAMETER(name, `an integer from ${min} to ${max}`)
  }
  return value
}

function identifier(value: string, name: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new WERR_INVALID_PARAMETER(name, 'a version-one snapshot archive identifier')
  }
}

function identity(value: string): void {
  if (typeof value !== 'string' || !/^(02|03)[0-9a-fA-F]{64}$/.test(value)) {
    throw new WERR_INVALID_PARAMETER('identityKey', 'a compressed public identity key')
  }
}

function validDate(value: Date): boolean {
  try {
    return Number.isFinite(Date.prototype.getTime.call(value))
  } catch {
    return false
  }
}

function hash(bytes: Uint8Array): string {
  return Utils.toHex(Hash.sha256(Array.from(bytes)))
}

function unavailable(): WERR_INVALID_OPERATION {
  return new WERR_INVALID_OPERATION('Snapshot archive is unavailable')
}

/**
 * Shared SQL staging with a fixed global reservation and at most one archive per
 * profile. Only auxiliary rows take the capacity lock; no source wallet row is
 * acquired under it. Capacity remains reserved until every page is deleted.
 */
export class KnexSnapshotArchiveStore {
  constructor(private readonly knex: Knex) {}

  private async now(k: Knex): Promise<number> {
    return await snapshotArchiveDatabaseNow(k)
  }

  private async capacity(k: Knex): Promise<{ archives: number; reservedBytes: number | string }> {
    return await lockSnapshotArchiveCapacity(k)
  }

  async begin(
    binding: SnapshotArchiveBinding,
    options: { maxBytes?: number; lifetimeMs?: number } = {}
  ): Promise<SnapshotArchiveWriter> {
    const reservedBytes = integer(
      options.maxBytes ?? snapshotArchiveLimits.archiveBytes,
      snapshotArchiveLimits.headerCharge + 1,
      snapshotArchiveLimits.archiveBytes,
      'maxBytes'
    )
    const lifetimeMs = integer(options.lifetimeMs ?? 300000, 1, snapshotArchiveLimits.lifetimeMs, 'lifetimeMs')
    identity(binding?.user?.identityKey)
    identifier(binding?.snapshotId, 'snapshotId')
    if (
      binding.version !== 1 ||
      !['main', 'test'].includes(binding.sourceStorage?.chain) ||
      typeof binding.sourceSchema !== 'string' ||
      binding.sourceSchema.length < 1 ||
      binding.sourceSchema.length > 256 ||
      typeof binding.sourceStorage.storageIdentityKey !== 'string' ||
      binding.sourceStorage.storageIdentityKey.length < 1 ||
      binding.sourceStorage.storageIdentityKey.length > 130
    ) {
      throw new WERR_INVALID_PARAMETER('binding', 'a version-one source/profile binding')
    }
    integer(binding.user.userId, 1, Number.MAX_SAFE_INTEGER, 'userId')
    for (const row of [binding.sourceStorage, binding.user]) {
      for (const value of [row.created_at, row.updated_at]) {
        if (!validDate(value)) {
          throw new WERR_INVALID_PARAMETER('binding', 'valid source and profile dates')
        }
      }
    }
    const identityKey = binding.user.identityKey
    const encoded = JSON.stringify(binding)
    const bytes = new TextEncoder().encode(encoded)
    const usedBytes = bytes.length + snapshotArchiveLimits.headerCharge
    if (bytes.length > snapshotArchiveLimits.bindingBytes || usedBytes > reservedBytes) {
      throw new SnapshotResourceLimitError('Snapshot archive metadata exceeds its reservation')
    }
    const writer = { archiveId: Utils.toHex(Random(32)), writerToken: Utils.toHex(Random(32)) }
    await this.knex.transaction(async trx => {
      const capacity = await this.capacity(trx)
      const occupied = await trx('snapshot_archives').where({ identityKey }).first('archiveId')
      if (
        occupied !== undefined ||
        capacity.archives >= snapshotArchiveLimits.archives ||
        Number(capacity.reservedBytes) + reservedBytes > snapshotArchiveLimits.totalBytes
      ) {
        throw new SnapshotResourceLimitError('Snapshot archive capacity is occupied')
      }
      await trx('snapshot_archives').insert({
        ...writer,
        identityKey,
        state: 'building',
        binding: encoded,
        expiresAt: (await this.now(trx)) + lifetimeMs,
        reservedBytes,
        usedBytes,
        nextSequence: 0,
        tableIndex: 0,
        rows: 0,
        digest: hash(bytes)
      })
      await trx('snapshot_archive_capacity')
        .where({ id: 1 })
        .update({
          archives: capacity.archives + 1,
          reservedBytes: Number(capacity.reservedBytes) + reservedBytes
        })
    })
    return writer
  }

  private async ownedWriter(k: Knex, writer: SnapshotArchiveWriter): Promise<ArchiveRow> {
    identifier(writer.archiveId, 'archiveId')
    identifier(writer.writerToken, 'writerToken')
    const row: ArchiveRow | undefined = await k('snapshot_archives').where(writer).first()
    if (row === undefined || row.state === 'closing' || Number(row.expiresAt) <= (await this.now(k)))
      throw unavailable()
    return row
  }

  async append(writer: SnapshotArchiveWriter, page: Omit<SnapshotArchivePage, 'digest'>): Promise<void> {
    integer(page.sequence, 0, snapshotArchiveLimits.pages - 1, 'sequence')
    integer(page.rows, 0, snapshotArchiveLimits.rowsPerPage, 'rows')
    if (
      !snapshotArchiveTables.includes(page.table) ||
      typeof page.done !== 'boolean' ||
      !(page.bytes instanceof Uint8Array) ||
      page.bytes.length < 1 ||
      page.bytes.length > snapshotArchiveLimits.pageBytes ||
      (page.rows === 0 && !page.done)
    )
      throw new WERR_INVALID_PARAMETER('page', 'a bounded snapshot archive page')
    // Detach before taking an asynchronous lock, including caller-owned typed bytes.
    const owner = { archiveId: writer.archiveId, writerToken: writer.writerToken }
    const input = { ...page, bytes: new Uint8Array(page.bytes) }
    const digest = hash(input.bytes)
    await this.knex.transaction(async trx => {
      await this.capacity(trx)
      const row = await this.ownedWriter(trx, owner)
      if (input.sequence < row.nextSequence) {
        const prior: PageRow | undefined = await trx('snapshot_archive_pages')
          .where({ archiveId: row.archiveId, sequence: input.sequence })
          .first()
        if (
          prior?.digest !== digest ||
          prior.tableName !== input.table ||
          prior.rows !== input.rows ||
          Boolean(prior.done) !== input.done
        )
          throw unavailable()
        return
      }
      if (
        row.state !== 'building' ||
        input.sequence !== row.nextSequence ||
        input.table !== snapshotArchiveTables[row.tableIndex]
      )
        throw unavailable()
      const usedBytes = Number(row.usedBytes) + input.bytes.length + snapshotArchiveLimits.pageCharge
      if (usedBytes > Number(row.reservedBytes))
        throw new SnapshotResourceLimitError('Snapshot archive reservation exhausted')
      await trx('snapshot_archive_pages').insert({
        archiveId: row.archiveId,
        sequence: input.sequence,
        tableName: input.table,
        rows: input.rows,
        done: input.done,
        digest,
        payload: Buffer.from(input.bytes)
      })
      const receipt = new TextEncoder().encode(
        JSON.stringify([row.digest, input.sequence, input.table, input.rows, input.done, digest])
      )
      await trx('snapshot_archives')
        .where({ archiveId: row.archiveId })
        .update({
          usedBytes,
          nextSequence: row.nextSequence + 1,
          tableIndex: row.tableIndex + Number(input.done),
          rows: Number(row.rows) + input.rows,
          digest: hash(receipt)
        })
    })
  }

  private manifest(row: ArchiveRow): SnapshotArchiveManifest {
    const binding = JSON.parse(row.binding) as SnapshotArchiveBinding
    for (const metadata of [binding.sourceStorage, binding.user]) {
      metadata.created_at = new Date(String(metadata.created_at))
      metadata.updated_at = new Date(String(metadata.updated_at))
    }
    return {
      version: 1,
      archiveId: row.archiveId,
      binding,
      expiresAt: Number(row.expiresAt),
      pages: row.nextSequence,
      rows: Number(row.rows),
      digest: row.digest
    }
  }

  /** The capture controller must validate the complete source closure before sealing. */
  async seal(writer: SnapshotArchiveWriter): Promise<SnapshotArchiveManifest> {
    const owner = { archiveId: writer.archiveId, writerToken: writer.writerToken }
    return await this.knex.transaction(async trx => {
      await this.capacity(trx)
      const row = await this.ownedWriter(trx, owner)
      if (row.tableIndex !== snapshotArchiveTables.length) throw unavailable()
      await trx('snapshot_archives').where({ archiveId: row.archiveId }).update({ state: 'ready' })
      return this.manifest(row)
    })
  }

  private async ready(identityKey: string, archiveId: string): Promise<ArchiveRow> {
    identity(identityKey)
    identifier(archiveId, 'archiveId')
    const row: ArchiveRow | undefined = await this.knex('snapshot_archives')
      .where({ archiveId, identityKey, state: 'ready' })
      .first()
    if (row === undefined || Number(row.expiresAt) <= (await this.now(this.knex))) throw unavailable()
    return row
  }

  async inspect(identityKey: string, archiveId: string): Promise<SnapshotArchiveManifest> {
    return this.manifest(await this.ready(identityKey, archiveId))
  }

  /** Bounded inclusion metadata, without fetching any staged row payloads. */
  async directory(identityKey: string, archiveId: string): Promise<SnapshotArchiveDirectory> {
    const header = await this.ready(identityKey, archiveId)
    const pages: Array<Omit<PageRow, 'payload' | 'archiveId'>> = await this.knex('snapshot_archive_pages')
      .select('sequence', 'tableName', 'rows', 'done', 'digest')
      .where({ archiveId })
      .orderBy('sequence')
      .limit(snapshotArchiveLimits.pages)
    if (pages.length !== header.nextSequence) throw unavailable()
    // A concurrent close or expiry must not publish a newly stale directory.
    await this.ready(identityKey, archiveId)
    return {
      version: 1,
      encoding: snapshotArchiveEncoding,
      archiveId,
      expiresAt: Number(header.expiresAt),
      pages: header.nextSequence,
      rows: Number(header.rows),
      digest: header.digest,
      bindingJson: header.binding,
      receipts: pages.map(page => ({
        sequence: page.sequence,
        table: page.tableName,
        rows: page.rows,
        done: Boolean(page.done),
        digest: page.digest
      }))
    }
  }

  async read(identityKey: string, archiveId: string, sequence: number): Promise<SnapshotArchivePage> {
    integer(sequence, 0, snapshotArchiveLimits.pages - 1, 'sequence')
    const header = await this.ready(identityKey, archiveId)
    if (sequence >= header.nextSequence) throw unavailable()
    const page: PageRow | undefined = await this.knex('snapshot_archive_pages').where({ archiveId, sequence }).first()
    if (page === undefined) throw unavailable()
    if (hash(page.payload) !== page.digest) throw unavailable()
    // Release/expiry during I/O cannot return a newly stale page.
    await this.ready(identityKey, archiveId)
    return {
      sequence,
      table: page.tableName,
      rows: page.rows,
      done: Boolean(page.done),
      digest: page.digest,
      bytes: new Uint8Array(page.payload)
    }
  }

  async close(identityKey: string, archiveId: string): Promise<void> {
    identity(identityKey)
    identifier(archiveId, 'archiveId')
    const found = await this.knex.transaction(async trx => {
      await this.capacity(trx)
      const row = await trx('snapshot_archives').where({ archiveId, identityKey }).first('archiveId')
      if (row === undefined) return false
      await trx('snapshot_archives').where({ archiveId, identityKey }).update({ state: 'closing' })
      return true
    })
    if (!found) return
    // Bounded exact-key deletes do not hold source wallet locks or release the
    // capacity reservation early. A crash or concurrent closer can resume them.
    let hasPages = true
    function* pendingBatches(): Generator<void> {
      while (hasPages) yield undefined
    }
    await runInSeries(pendingBatches(), async () => {
      const rows: Array<{ sequence: number }> = await this.knex('snapshot_archive_pages')
        .select('sequence')
        .where({ archiveId })
        .orderBy('sequence')
        .limit(32)
      hasPages = rows.length > 0
      if (hasPages)
        await this.knex('snapshot_archive_pages')
          .where({ archiveId })
          .whereIn(
            'sequence',
            rows.map(row => row.sequence)
          )
          .delete()
    })
    await this.knex.transaction(async trx => {
      const capacity = await this.capacity(trx)
      const row: ArchiveRow | undefined = await trx('snapshot_archives')
        .where({ archiveId, identityKey, state: 'closing' })
        .first()
      if (row === undefined) return
      await trx('snapshot_archives').where({ archiveId }).delete()
      await trx('snapshot_archive_capacity')
        .where({ id: 1 })
        .update({
          archives: capacity.archives - 1,
          reservedBytes: Number(capacity.reservedBytes) - Number(row.reservedBytes)
        })
    })
  }

  /** Recover expired or interrupted cleanup without making incomplete captures readable. */
  async reap(): Promise<void> {
    const rows: Array<{ archiveId: string; identityKey: string }> = await this.knex('snapshot_archives')
      .select('archiveId', 'identityKey')
      .where('expiresAt', '<=', await this.now(this.knex))
      .orWhere({ state: 'closing' })
      .orderBy('archiveId')
      .limit(snapshotArchiveLimits.archives)
    await runInSeries(rows, row => this.close(row.identityKey, row.archiveId))
  }
}
