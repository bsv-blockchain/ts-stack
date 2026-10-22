import {
  snapshotJournalFieldArchiveStorageTable,
  parseSnapshotJournalFieldArchiveStorageTable,
  snapshotJournalArchiveStorageTable,
  parseSnapshotJournalArchiveStorageTable
} from '../journal/SnapshotJournalArchiveStorageTable'
import {
  parseSnapshotJournalFieldArchiveBinding,
  type SnapshotJournalFieldArchiveBinding,
  type SnapshotJournalFieldArchiveManifest,
  parseSnapshotJournalArchiveBinding,
  snapshotJournalArchiveStreams,
  type SnapshotJournalArchiveBinding,
  type SnapshotJournalArchiveManifest
} from '../journal/SnapshotJournalArchiveBinding'
import {
  decodeSnapshotJournalFieldArchivePacket,
  parseSnapshotJournalFieldContentIndex,
  snapshotJournalFieldContentIndexFromHeader,
  type SnapshotJournalFieldContentIndex,
  snapshotJournalFieldArchiveEncoding,
  decodeSnapshotJournalArchivePacket,
  snapshotJournalArchiveEncoding
} from '../journal/SnapshotJournalArchivePacket'
import { parseSnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import { hasSnapshotArchiveOwner, SnapshotArchiveCleanupPendingError } from './SnapshotArchiveOwner'
import { Hash, Random, Utils } from '@bsv/sdk'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
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
  tableName: string
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
  return Utils.toHex(Hash.sha256(bytes))
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
      ![1, 2].includes(binding.version) ||
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
    if (binding.version === 1 && Object.hasOwn(binding, 'contentRevision'))
      throw new WERR_INVALID_PARAMETER('binding', 'a version-one binding without content revision')
    const identityKey = binding.user.identityKey
    let contentRevision: ReturnType<typeof parseSnapshotSyncContentRevision> | undefined
    if (binding.version === 2) {
      try {
        contentRevision = parseSnapshotSyncContentRevision(binding.contentRevision)
      } catch {
        throw new WERR_INVALID_PARAMETER('binding', 'a version-two binding with valid content revision DATA')
      }
    }
    const encoded = JSON.stringify(binding.version === 1 ? binding : { ...binding, contentRevision })
    return await this.beginEncoded(identityKey, encoded, reservedBytes, lifetimeMs)
  }

  /** Separate producer admission: a journal artifact never enters the row
   * archive API, even though its charged auxiliary storage is shared. */
  async beginJournal(
    input: SnapshotJournalArchiveBinding,
    options: { maxBytes?: number; lifetimeMs?: number } = {}
  ): Promise<SnapshotArchiveWriter> {
    const binding = parseSnapshotJournalArchiveBinding(input),
      reservedBytes = integer(
        options.maxBytes ?? snapshotArchiveLimits.archiveBytes,
        snapshotArchiveLimits.headerCharge + 1,
        snapshotArchiveLimits.archiveBytes,
        'maxBytes'
      ),
      lifetimeMs = integer(options.lifetimeMs ?? 300000, 1, snapshotArchiveLimits.lifetimeMs, 'lifetimeMs'),
      now = await this.now(this.knex)
    if (now + lifetimeMs > binding.journal.receipt.expiresAt) throw unavailable()
    return await this.beginEncoded(
      binding.user.identityKey,
      JSON.stringify(binding),
      reservedBytes,
      lifetimeMs,
      binding.journal.receipt.expiresAt
    )
  }

  async beginJournalFields(
    input: SnapshotJournalFieldArchiveBinding,
    options: { maxBytes?: number; lifetimeMs?: number } = {}
  ): Promise<SnapshotArchiveWriter> {
    const binding = parseSnapshotJournalFieldArchiveBinding(input),
      reservedBytes = integer(
        options.maxBytes ?? snapshotArchiveLimits.archiveBytes,
        snapshotArchiveLimits.headerCharge + 1,
        snapshotArchiveLimits.archiveBytes,
        'maxBytes'
      ),
      lifetimeMs = integer(options.lifetimeMs ?? 300000, 1, snapshotArchiveLimits.lifetimeMs, 'lifetimeMs'),
      now = await this.now(this.knex)
    if (now + lifetimeMs > binding.journal.receipt.expiresAt) throw unavailable()
    return await this.beginEncoded(
      binding.user.identityKey,
      JSON.stringify(binding),
      reservedBytes,
      lifetimeMs,
      binding.journal.receipt.expiresAt
    )
  }

  private async beginEncoded(
    identityKey: string,
    encoded: string,
    reservedBytes: number,
    lifetimeMs: number,
    maximumExpiresAt = Number.MAX_SAFE_INTEGER
  ): Promise<SnapshotArchiveWriter> {
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
      const expiresAt = (await this.now(trx)) + lifetimeMs
      if (expiresAt > maximumExpiresAt) throw unavailable()
      await trx('snapshot_archives').insert({
        ...writer,
        identityKey,
        state: 'building',
        binding: encoded,
        expiresAt,
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

  async append(
    writer: SnapshotArchiveWriter,
    page: Omit<SnapshotArchivePage, 'digest'>,
    authorize?: (trx: Knex) => Promise<void>
  ): Promise<void> {
    await this.appendPage(writer, page, authorize, false)
  }

  async appendJournal(
    writer: SnapshotArchiveWriter,
    page: Omit<SnapshotArchivePage, 'digest'>,
    authorize?: (trx: Knex) => Promise<void>
  ): Promise<void> {
    await this.appendPage(writer, page, authorize, true)
  }

  async appendJournalFields(
    writer: SnapshotArchiveWriter,
    page: Omit<SnapshotArchivePage, 'digest'>,
    authorize?: (trx: Knex) => Promise<void>
  ): Promise<void> {
    await this.appendPage(writer, page, authorize, 'fields')
  }

  private async appendPage(
    writer: SnapshotArchiveWriter,
    page: Omit<SnapshotArchivePage, 'digest'>,
    authorize: ((trx: Knex) => Promise<void>) | undefined,
    journal: boolean | 'fields'
  ): Promise<void> {
    integer(page.sequence, 0, snapshotArchiveLimits.pages - 1, 'sequence')
    integer(page.rows, 0, snapshotArchiveLimits.rowsPerPage, 'rows')
    if (
      !snapshotArchiveTables.includes(page.table) ||
      typeof page.done !== 'boolean' ||
      !(page.bytes instanceof Uint8Array) ||
      page.bytes.length < 1 ||
      page.bytes.length > snapshotArchiveLimits.pageBytes ||
      (page.rows === 0 && !page.done && !journal)
    )
      throw new WERR_INVALID_PARAMETER('page', 'a bounded snapshot archive page')
    // Detach before taking an asynchronous lock, including caller-owned typed bytes.
    const owner = { archiveId: writer.archiveId, writerToken: writer.writerToken }
    const input = { ...page, bytes: new Uint8Array(page.bytes) }
    const digest = hash(input.bytes)
    await this.knex.transaction(async trx => {
      await this.capacity(trx)
      await authorize?.(trx)
      const row = await this.ownedWriter(trx, owner)
      if (this.journalRow(row) !== journal) throw unavailable()
      if (input.sequence < row.nextSequence) {
        const prior: PageRow | undefined = await trx('snapshot_archive_pages')
          .where({ archiveId: row.archiveId, sequence: input.sequence })
          .first()
        const priorTable =
          prior === undefined
            ? undefined
            : journal
              ? (journal === 'fields'
                  ? parseSnapshotJournalFieldArchiveStorageTable(prior.tableName)
                  : parseSnapshotJournalArchiveStorageTable(prior.tableName)
                ).table
              : prior.tableName
        if (
          prior?.digest !== digest ||
          priorTable !== input.table ||
          prior.rows !== input.rows ||
          Boolean(prior.done) !== input.done
        )
          throw unavailable()
        return
      }
      if (row.state !== 'building' || input.sequence !== row.nextSequence) throw unavailable()
      let storedTable: string = input.table,
        contentIndex: Readonly<SnapshotJournalFieldContentIndex> | null = null
      if (journal) {
        const binding =
            journal === 'fields'
              ? parseSnapshotJournalFieldArchiveBinding(JSON.parse(row.binding))
              : parseSnapshotJournalArchiveBinding(JSON.parse(row.binding)),
          stream = snapshotJournalArchiveStreams[row.tableIndex]
        if (stream === undefined || input.table !== stream.table) throw unavailable()
        const packet = (
            journal === 'fields' ? decodeSnapshotJournalFieldArchivePacket : decodeSnapshotJournalArchivePacket
          )(input.bytes, { stream: stream.stream, tableId: stream.tableId }, binding.journal.receipt.highWater),
          frame = packet.kind === 'field-frame' || packet.kind === 'frame' ? packet : undefined
        if (packet.kind === 'field-content')
          contentIndex = parseSnapshotJournalFieldContentIndex({
            frameDigest: packet.frameDigest,
            changeIndex: packet.changeIndex,
            field: packet.field,
            descriptor: packet.descriptor,
            offset: packet.offset,
            length: packet.bytes.length
          })
        if (
          input.rows !== (frame === undefined ? 0 : frame.page.changes.length) ||
          input.done !== (frame !== undefined && frame.page.complete)
        )
          throw unavailable()
        storedTable =
          journal === 'fields'
            ? snapshotJournalFieldArchiveStorageTable(
                frame !== undefined ? 'frame' : packet.kind === 'field-content' ? 'content' : 'identities',
                stream
              )
            : snapshotJournalArchiveStorageTable(frame === undefined ? 'identities' : 'frame', stream)
      } else if (input.table !== snapshotArchiveTables[row.tableIndex]) throw unavailable()
      const usedBytes = Number(row.usedBytes) + input.bytes.length + snapshotArchiveLimits.pageCharge
      if (usedBytes > Number(row.reservedBytes))
        throw new SnapshotResourceLimitError('Snapshot archive reservation exhausted')
      await trx('snapshot_archive_pages').insert({
        archiveId: row.archiveId,
        sequence: input.sequence,
        tableName: storedTable,
        rows: input.rows,
        done: input.done,
        digest,
        payload: Buffer.from(input.bytes)
      })
      const receipt = new TextEncoder().encode(
        JSON.stringify([
          row.digest,
          input.sequence,
          storedTable,
          input.rows,
          input.done,
          digest,
          ...(journal === 'fields' ? [contentIndex] : [])
        ])
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

  private journalRow(row: ArchiveRow): boolean | 'fields' {
    if (typeof row.binding !== 'string' || row.binding.length > snapshotArchiveLimits.bindingBytes) throw unavailable()
    const binding: unknown = JSON.parse(row.binding)
    if (binding === null || typeof binding !== 'object') throw unavailable()
    const version = Object.getOwnPropertyDescriptor(binding, 'version')?.value
    if (version === 4) {
      parseSnapshotJournalFieldArchiveBinding(binding)
      return 'fields'
    }
    if (version === 3) {
      parseSnapshotJournalArchiveBinding(binding)
      return true
    }
    if (version !== 1 && version !== 2) throw unavailable()
    return false
  }

  private journalManifest(row: ArchiveRow): SnapshotJournalArchiveManifest {
    if (this.journalRow(row) !== true) throw unavailable()
    return {
      version: 1,
      archiveId: row.archiveId,
      binding: parseSnapshotJournalArchiveBinding(JSON.parse(row.binding)),
      expiresAt: Number(row.expiresAt),
      pages: row.nextSequence,
      rows: Number(row.rows),
      digest: row.digest
    }
  }

  private journalFieldManifest(row: ArchiveRow): SnapshotJournalFieldArchiveManifest {
    if (this.journalRow(row) !== 'fields') throw unavailable()
    return {
      version: 1,
      archiveId: row.archiveId,
      binding: parseSnapshotJournalFieldArchiveBinding(JSON.parse(row.binding)),
      expiresAt: Number(row.expiresAt),
      pages: row.nextSequence,
      rows: Number(row.rows),
      digest: row.digest
    }
  }

  private manifest(row: ArchiveRow): SnapshotArchiveManifest {
    if (this.journalRow(row)) throw unavailable()
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
      if (this.journalRow(row) || row.tableIndex !== snapshotArchiveTables.length) throw unavailable()
      await trx('snapshot_archives').where({ archiveId: row.archiveId }).update({ state: 'ready' })
      return this.manifest(row)
    })
  }

  async sealJournal(writer: SnapshotArchiveWriter): Promise<SnapshotJournalArchiveManifest> {
    const owner = { archiveId: writer.archiveId, writerToken: writer.writerToken }
    return await this.knex.transaction(async trx => {
      await this.capacity(trx)
      const row = await this.ownedWriter(trx, owner)
      if (this.journalRow(row) !== true || row.tableIndex !== snapshotJournalArchiveStreams.length) throw unavailable()
      await trx('snapshot_archives').where({ archiveId: row.archiveId }).update({ state: 'ready' })
      return this.journalManifest(row)
    })
  }

  async sealJournalFields(writer: SnapshotArchiveWriter): Promise<SnapshotJournalFieldArchiveManifest> {
    const owner = { archiveId: writer.archiveId, writerToken: writer.writerToken }
    return await this.knex.transaction(async trx => {
      await this.capacity(trx)
      const row = await this.ownedWriter(trx, owner)
      if (this.journalRow(row) !== 'fields' || row.tableIndex !== snapshotJournalArchiveStreams.length)
        throw unavailable()
      await trx('snapshot_archives').where({ archiveId: row.archiveId }).update({ state: 'ready' })
      return this.journalFieldManifest(row)
    })
  }

  private async ready(
    identityKey: string,
    archiveId: string,
    journal: boolean | 'fields' = false
  ): Promise<ArchiveRow> {
    identity(identityKey)
    identifier(archiveId, 'archiveId')
    const row: ArchiveRow | undefined = await this.knex('snapshot_archives')
      .where({ archiveId, identityKey, state: 'ready' })
      .first()
    if (row === undefined || this.journalRow(row) !== journal || Number(row.expiresAt) <= (await this.now(this.knex)))
      throw unavailable()
    return row
  }

  async inspect(identityKey: string, archiveId: string): Promise<SnapshotArchiveManifest> {
    return this.manifest(await this.ready(identityKey, archiveId))
  }

  async inspectJournal(identityKey: string, archiveId: string): Promise<SnapshotJournalArchiveManifest> {
    return this.journalManifest(await this.ready(identityKey, archiveId, true))
  }

  async inspectJournalFields(identityKey: string, archiveId: string): Promise<SnapshotJournalFieldArchiveManifest> {
    return this.journalFieldManifest(await this.ready(identityKey, archiveId, 'fields'))
  }
  async journalFieldsDirectory(identityKey: string, archiveId: string) {
    return await this.directoryData(identityKey, archiveId, 'fields')
  }

  async journalDirectory(identityKey: string, archiveId: string) {
    return await this.directoryData(identityKey, archiveId, true)
  }

  /** Bounded inclusion metadata, without fetching any staged row payloads. */
  async directory(identityKey: string, archiveId: string): Promise<SnapshotArchiveDirectory> {
    return { ...(await this.directoryData(identityKey, archiveId, false)), encoding: snapshotArchiveEncoding }
  }

  private async directoryData(identityKey: string, archiveId: string, journal: boolean | 'fields') {
    const header = await this.ready(identityKey, archiveId, journal)
    const pages: Array<
      Omit<PageRow, 'payload' | 'archiveId'> & { fieldHeader?: Uint8Array | null; packetBytes?: number | string }
    > = await this.knex('snapshot_archive_pages')
      .select(
        'sequence',
        'tableName',
        'rows',
        'done',
        'digest',
        ...(journal === 'fields'
          ? [
              this.knex.raw(
                "CASE WHEN tableName LIKE 'journal-fields-content/%' THEN substr(payload,1,4096) ELSE NULL END AS fieldHeader"
              ),
              this.knex.raw('length(payload) AS packetBytes')
            ]
          : [])
      )
      .where({ archiveId })
      .orderBy('sequence')
      .limit(snapshotArchiveLimits.pages)
    if (pages.length !== header.nextSequence) throw unavailable()
    // A concurrent close or expiry must not publish a newly stale directory.
    await this.ready(identityKey, archiveId, journal)
    return {
      version: 1 as const,
      encoding:
        journal === 'fields'
          ? snapshotJournalFieldArchiveEncoding
          : journal
            ? snapshotJournalArchiveEncoding
            : snapshotArchiveEncoding,
      archiveId,
      expiresAt: Number(header.expiresAt),
      pages: header.nextSequence,
      rows: Number(header.rows),
      digest: header.digest,
      bindingJson: header.binding,
      receipts: pages.map(page => {
        const packet =
            journal === 'fields'
              ? parseSnapshotJournalFieldArchiveStorageTable(page.tableName)
              : journal
                ? parseSnapshotJournalArchiveStorageTable(page.tableName)
                : undefined,
          table = packet?.table ?? snapshotArchiveTables.find(table => table === page.tableName)
        if (table === undefined) throw unavailable()
        return {
          sequence: page.sequence,
          table,
          rows: page.rows,
          done: Boolean(page.done),
          digest: page.digest,
          ...(packet === undefined ? {} : { packet: packet.packet, stream: packet.stream, tableId: packet.tableId }),
          ...(journal === 'fields'
            ? {
                content:
                  packet?.packet === 'content'
                    ? snapshotJournalFieldContentIndexFromHeader(page.fieldHeader!, Number(page.packetBytes), {
                        stream: packet.stream,
                        tableId: packet.tableId
                      })
                    : null
              }
            : {})
        }
      })
    }
  }

  async read(identityKey: string, archiveId: string, sequence: number): Promise<SnapshotArchivePage> {
    return await this.readPage(identityKey, archiveId, sequence, false)
  }

  async readJournal(identityKey: string, archiveId: string, sequence: number): Promise<SnapshotArchivePage> {
    return await this.readPage(identityKey, archiveId, sequence, true)
  }

  async readJournalFields(identityKey: string, archiveId: string, sequence: number): Promise<SnapshotArchivePage> {
    return await this.readPage(identityKey, archiveId, sequence, 'fields')
  }

  private async readPage(
    identityKey: string,
    archiveId: string,
    sequence: number,
    journal: boolean | 'fields'
  ): Promise<SnapshotArchivePage> {
    integer(sequence, 0, snapshotArchiveLimits.pages - 1, 'sequence')
    const header = await this.ready(identityKey, archiveId, journal)
    if (sequence >= header.nextSequence) throw unavailable()
    const page: PageRow | undefined = await this.knex('snapshot_archive_pages').where({ archiveId, sequence }).first()
    if (page === undefined) throw unavailable()
    if (hash(page.payload) !== page.digest) throw unavailable()
    // Release/expiry during I/O cannot return a newly stale page.
    await this.ready(identityKey, archiveId, journal)
    const table = journal
      ? (journal === 'fields'
          ? parseSnapshotJournalFieldArchiveStorageTable(page.tableName)
          : parseSnapshotJournalArchiveStorageTable(page.tableName)
        ).table
      : snapshotArchiveTables.find(table => table === page.tableName)
    if (table === undefined) throw unavailable()
    return {
      sequence,
      table,
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
      if (row === undefined) return 'absent'
      await trx('snapshot_archives').where({ archiveId, identityKey }).update({ state: 'closing' })
      return (await hasSnapshotArchiveOwner(trx, { identityKey, archiveId })) ? 'pending' : 'ready'
    })
    if (found === 'absent') return
    if (found === 'pending') throw new SnapshotArchiveCleanupPendingError()
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
    await runInSeries(rows, async row => {
      try {
        await this.close(row.identityKey, row.archiveId)
      } catch (error) {
        if (!(error instanceof SnapshotArchiveCleanupPendingError)) throw error
      }
    })
  }
}
