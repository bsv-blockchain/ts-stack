import { Random, Utils } from '@bsv/sdk'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import {
  snapshotArchiveLimits,
  type SnapshotArchiveBinding,
  type SnapshotArchiveWriter,
  type SnapshotArchiveManifest
} from './SnapshotArchive'
import { lockSnapshotArchiveCapacity, snapshotArchiveDatabaseNow } from './SnapshotArchiveSql'
import {
  parseSnapshotArchiveRequest,
  validateSnapshotArchiveRequest,
  type SnapshotArchiveRequestOwner,
  type SnapshotArchiveRequestReceipt,
  type SnapshotArchiveTerminalState
} from './SnapshotArchiveRequest'

interface RequestRow {
  identityKey: string
  requestId: string
  claimToken: string
  state: 'claimed' | 'capturing' | 'ready' | SnapshotArchiveTerminalState
  requestJson: string
  expiresAt: number | string
  reservedBytes: number | string
  archiveId: string | null
  released: boolean | number
}

const table = 'snapshot_archive_requests'
export const snapshotArchiveRequestLimits = Object.freeze({ perProfile: 4, total: 64 })

function unavailable(): never {
  throw new WERR_INVALID_OPERATION('Snapshot archive request is unavailable')
}

function identity(value: string): void {
  if (typeof value !== 'string' || !/^(02|03)[0-9a-fA-F]{64}$/.test(value)) {
    throw new WERR_INVALID_PARAMETER('identityKey', 'a compressed public identity key')
  }
}

function identifier(value: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new WERR_INVALID_PARAMETER('requestId', 'a version-one snapshot archive request identifier')
  }
}

/** Durable deduplication with admission charged before opening a source pool. */
export class KnexSnapshotArchiveRequestStore {
  constructor(private readonly knex: Knex) {}

  private async receipt(k: Knex, row: RequestRow): Promise<SnapshotArchiveRequestReceipt> {
    const base = { version: 1 as const, requestId: row.requestId, expiresAt: Number(row.expiresAt) }
    if (base.expiresAt <= (await snapshotArchiveDatabaseNow(k))) return { ...base, state: 'expired' }
    if (row.state === 'ready') {
      if (row.archiveId === null) unavailable()
      const archive = await new KnexSnapshotArchiveStore(k).inspect(row.identityKey, row.archiveId)
      return { ...base, state: 'ready', archiveId: archive.archiveId, digest: archive.digest }
    }
    return { ...base, state: row.state === 'claimed' || row.state === 'capturing' ? 'building' : row.state }
  }

  async claim(
    identityKey: string,
    input: unknown
  ): Promise<{ receipt: SnapshotArchiveRequestReceipt; owner?: SnapshotArchiveRequestOwner }> {
    identity(identityKey)
    const request = parseSnapshotArchiveRequest(input)
    const requestJson = JSON.stringify(request)
    return await this.knex.transaction(async trx => {
      const capacity = await lockSnapshotArchiveCapacity(trx)
      const now = await snapshotArchiveDatabaseNow(trx)
      validateSnapshotArchiveRequest(request, now)
      const existing: RequestRow | undefined = await trx(table)
        .where({ identityKey, requestId: request.requestId })
        .first()
      if (existing !== undefined) {
        if (existing.requestJson !== requestJson) unavailable()
        return { receipt: await this.receipt(trx, existing) }
      }
      await trx(table).where('expiresAt', '<=', now).where({ released: true }).delete()
      const retained: Array<Pick<RequestRow, 'identityKey' | 'released'>> = await trx(table)
        .select('identityKey', 'released')
        .limit(snapshotArchiveRequestLimits.total)
      const owned = retained.filter(row => row.identityKey === identityKey)
      const archive = await trx('snapshot_archives').where({ identityKey }).first('archiveId')
      if (
        retained.length >= snapshotArchiveRequestLimits.total ||
        owned.length >= snapshotArchiveRequestLimits.perProfile ||
        owned.some(row => !row.released) ||
        archive !== undefined ||
        capacity.archives >= snapshotArchiveLimits.archives ||
        Number(capacity.reservedBytes) + request.maxBytes > snapshotArchiveLimits.totalBytes
      )
        throw new SnapshotResourceLimitError('Snapshot archive request capacity is occupied')
      const owner = { identityKey, requestId: request.requestId, claimToken: Utils.toHex(Random(32)) }
      const row: RequestRow = {
        ...owner,
        state: 'claimed',
        requestJson,
        expiresAt: request.notAfter,
        reservedBytes: request.maxBytes,
        archiveId: null,
        released: false
      }
      await trx(table).insert(row)
      await trx('snapshot_archive_capacity')
        .where({ id: 1 })
        .update({ archives: capacity.archives + 1, reservedBytes: Number(capacity.reservedBytes) + request.maxBytes })
      return { receipt: await this.receipt(trx, row), owner }
    })
  }

  async status(identityKey: string, requestId: string): Promise<SnapshotArchiveRequestReceipt> {
    identity(identityKey)
    identifier(requestId)
    const row: RequestRow | undefined = await this.knex(table).where({ identityKey, requestId }).first()
    if (row === undefined) unavailable()
    return await this.receipt(this.knex, row)
  }

  private async owned(k: Knex, owner: SnapshotArchiveRequestOwner): Promise<RequestRow> {
    const row: RequestRow | undefined = await k(table).where(owner).first()
    if (row === undefined || row.released || Number(row.expiresAt) <= (await snapshotArchiveDatabaseNow(k)))
      unavailable()
    return row
  }

  /** The claim-to-archive assignment and accounting transition commit together. */
  async begin(owner: SnapshotArchiveRequestOwner, binding: SnapshotArchiveBinding): Promise<SnapshotArchiveWriter> {
    const claim = { ...owner }
    return await this.knex.transaction(async trx => {
      const capacity = await lockSnapshotArchiveCapacity(trx)
      const row = await this.owned(trx, claim)
      if (row.state !== 'claimed' || row.archiveId !== null || binding.user.identityKey !== row.identityKey)
        unavailable()
      const remaining = Number(row.expiresAt) - (await snapshotArchiveDatabaseNow(trx))
      if (remaining < 1) unavailable()
      await trx('snapshot_archive_capacity')
        .where({ id: 1 })
        .update({
          archives: capacity.archives - 1,
          reservedBytes: Number(capacity.reservedBytes) - Number(row.reservedBytes)
        })
      const writer = await new KnexSnapshotArchiveStore(trx).begin(binding, {
        maxBytes: Number(row.reservedBytes),
        lifetimeMs: remaining
      })
      await trx('snapshot_archives').where({ archiveId: writer.archiveId }).update({ expiresAt: row.expiresAt })
      await trx(table).where(claim).update({ state: 'capturing', archiveId: writer.archiveId })
      return writer
    })
  }

  async seal(owner: SnapshotArchiveRequestOwner, writer: SnapshotArchiveWriter): Promise<SnapshotArchiveManifest> {
    const claim = { ...owner }
    const captured = { ...writer }
    return await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      const row = await this.owned(trx, claim)
      if (!['capturing', 'ready'].includes(row.state) || row.archiveId !== captured.archiveId) unavailable()
      const manifest = await new KnexSnapshotArchiveStore(trx).seal(captured)
      await trx(table).where(claim).update({ state: 'ready' })
      return manifest
    })
  }

  async close(identityKey: string, requestId: string, state: SnapshotArchiveTerminalState = 'closed'): Promise<void> {
    identity(identityKey)
    identifier(requestId)
    await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      const row: RequestRow | undefined = await trx(table).where({ identityKey, requestId }).first()
      if (row !== undefined && ['claimed', 'capturing', 'ready'].includes(row.state)) {
        await trx(table).where({ identityKey, requestId }).update({ state })
      }
    })
    await this.release(identityKey, requestId)
  }

  private async release(identityKey: string, requestId: string): Promise<void> {
    const archiveId = await this.knex.transaction(async trx => {
      const capacity = await lockSnapshotArchiveCapacity(trx)
      const row: RequestRow | undefined = await trx(table).where({ identityKey, requestId }).first()
      if (row === undefined || row.released || !['closed', 'failed', 'expired', 'resource-limited'].includes(row.state))
        return undefined
      if (row.archiveId !== null) return row.archiveId
      await trx('snapshot_archive_capacity')
        .where({ id: 1 })
        .update({
          archives: capacity.archives - 1,
          reservedBytes: Number(capacity.reservedBytes) - Number(row.reservedBytes)
        })
      await trx(table).where({ identityKey, requestId }).update({ released: true })
      return undefined
    })
    if (archiveId === undefined) return
    await new KnexSnapshotArchiveStore(this.knex).close(identityKey, archiveId)
    await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      await trx(table).where({ identityKey, requestId, archiveId }).update({ released: true })
    })
  }

  async reap(): Promise<void> {
    const now = await snapshotArchiveDatabaseNow(this.knex)
    const rows: RequestRow[] = await this.knex(table)
      .where(query => {
        void query.where('expiresAt', '<=', now).orWhereIn('state', ['closed', 'failed', 'expired', 'resource-limited'])
      })
      .limit(snapshotArchiveRequestLimits.total)
    await runInSeries(rows, async row => {
      if (Number(row.expiresAt) <= now) await this.close(row.identityKey, row.requestId, 'expired')
      else await this.release(row.identityKey, row.requestId)
    })
    await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      await trx(table).where('expiresAt', '<=', now).where({ released: true }).delete()
    })
  }
}
