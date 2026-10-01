import {
  reserveSnapshotArchiveOwner,
  assignSnapshotArchiveOwner,
  releaseSnapshotArchiveOwner,
  hasSnapshotArchiveOwner,
  SnapshotArchiveCleanupPendingError
} from './SnapshotArchiveOwner'
import { Random, Utils } from '@bsv/sdk'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { SnapshotArchiveAdmissionLimitError } from './SnapshotArchiveAdmission'
import { validateSnapshotArchiveReaderOptions, type SnapshotArchiveReaderOptions } from './SnapshotArchiveReaderOffer'
import {
  parseSnapshotArchiveReaderRequest,
  validateSnapshotArchiveReaderRequest,
  snapshotArchiveReaderRequestId,
  type SnapshotArchiveReaderRequest
} from './SnapshotArchiveReaderRequest'
import { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import {
  snapshotArchiveLimits,
  type SnapshotArchiveBinding,
  type SnapshotArchiveWriter,
  type SnapshotArchiveManifest,
  type SnapshotArchivePage
} from './SnapshotArchive'
import { lockSnapshotArchiveCapacity, snapshotArchiveDatabaseNow } from './SnapshotArchiveSql'
import {
  parseSnapshotArchiveRequest,
  validateSnapshotArchiveRequest,
  type SnapshotArchiveRequest,
  type SnapshotArchiveRequestOwner,
  type SnapshotArchiveRequestReceipt,
  type SnapshotArchiveTerminalState
} from './SnapshotArchiveRequest'

interface RequestRow {
  identityKey: string
  requestId: string
  claimToken: string
  state: 'offered' | 'claimed' | 'capturing' | 'ready' | SnapshotArchiveTerminalState
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
  constructor(
    private readonly knex: Knex,
    private readonly requireSourceDrain = false,
    private readonly guardedSources = false
  ) {}

  private async receipt(k: Knex, row: RequestRow): Promise<SnapshotArchiveRequestReceipt> {
    const base = { version: 1 as const, requestId: row.requestId, expiresAt: Number(row.expiresAt) }
    if (base.expiresAt <= (await snapshotArchiveDatabaseNow(k))) return { ...base, state: 'expired' }
    if (row.state === 'ready') {
      if (row.archiveId === null) unavailable()
      const archive = await new KnexSnapshotArchiveStore(k).inspect(row.identityKey, row.archiveId)
      return { ...base, state: 'ready', archiveId: archive.archiveId, digest: archive.digest }
    }
    if (row.state === 'offered' || row.state === 'claimed' || row.state === 'capturing')
      return { ...base, state: 'building' }
    return { ...base, state: row.state }
  }

  async offer(
    identityKey: string,
    input: SnapshotArchiveReaderOptions
  ): Promise<{ serverTime: number; request: Readonly<SnapshotArchiveReaderRequest> } | undefined> {
    identity(identityKey)
    const options = validateSnapshotArchiveReaderOptions(input)
    return await this.knex.transaction(async trx => {
      const capacity = await lockSnapshotArchiveCapacity(trx)
      const now = await snapshotArchiveDatabaseNow(trx)
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
        Number(capacity.reservedBytes) + options.maxBytes > snapshotArchiveLimits.totalBytes
      )
        return undefined
      const fields = {
        version: 2 as const,
        nonce: Utils.toHex(Random(32)),
        notAfter: now + options.lifetimeMs,
        maxBytes: options.maxBytes
      }
      const request = validateSnapshotArchiveReaderRequest(
        { ...fields, requestId: snapshotArchiveReaderRequestId(fields) },
        now
      )
      const row: RequestRow = {
        identityKey,
        requestId: request.requestId,
        claimToken: '',
        state: 'offered',
        requestJson: JSON.stringify(request),
        expiresAt: request.notAfter,
        reservedBytes: 0,
        archiveId: null,
        released: true
      }
      await trx(table).insert(row)
      return { serverTime: now, request }
    })
  }

  async claim(
    identityKey: string,
    input: unknown
  ): Promise<{ receipt: SnapshotArchiveRequestReceipt; owner?: SnapshotArchiveRequestOwner }> {
    identity(identityKey)
    return await this.claimRequest(identityKey, parseSnapshotArchiveRequest(input), false)
  }

  /** Admission never creates an absent reader offer, including after completed cleanup. */
  async claimReader(
    identityKey: string,
    input: unknown
  ): Promise<{ receipt: SnapshotArchiveRequestReceipt; owner?: SnapshotArchiveRequestOwner }> {
    identity(identityKey)
    return await this.claimRequest(identityKey, parseSnapshotArchiveReaderRequest(input), true)
  }

  private async claimRequest(
    identityKey: string,
    request: Readonly<SnapshotArchiveRequest | SnapshotArchiveReaderRequest>,
    reader: boolean
  ): Promise<{ receipt: SnapshotArchiveRequestReceipt; owner?: SnapshotArchiveRequestOwner }> {
    const requestJson = JSON.stringify(request)
    return await this.knex.transaction(async trx => {
      const capacity = await lockSnapshotArchiveCapacity(trx)
      const now = await snapshotArchiveDatabaseNow(trx)
      if (reader) validateSnapshotArchiveReaderRequest(request, now)
      else validateSnapshotArchiveRequest(request, now)
      const existing: RequestRow | undefined = await trx(table)
        .where({ identityKey, requestId: request.requestId })
        .first()
      if (existing !== undefined) {
        if (existing.requestJson !== requestJson) unavailable()
        if (!reader || existing.state !== 'offered') return { receipt: await this.receipt(trx, existing) }
      } else if (reader) {
        unavailable()
      }
      await trx(table).where('expiresAt', '<=', now).where({ released: true }).delete()
      const retained: Array<Pick<RequestRow, 'identityKey' | 'released'>> = await trx(table)
        .select('identityKey', 'released')
        .limit(snapshotArchiveRequestLimits.total)
      const owned = retained.filter(row => row.identityKey === identityKey)
      const archive = await trx('snapshot_archives').where({ identityKey }).first('archiveId')
      if (
        (!reader &&
          (retained.length >= snapshotArchiveRequestLimits.total ||
            owned.length >= snapshotArchiveRequestLimits.perProfile)) ||
        owned.some(row => !row.released) ||
        archive !== undefined ||
        capacity.archives >= snapshotArchiveLimits.archives ||
        Number(capacity.reservedBytes) + request.maxBytes > snapshotArchiveLimits.totalBytes
      )
        throw new SnapshotArchiveAdmissionLimitError('Snapshot archive request capacity is occupied')
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
      if (reader) await trx(table).where({ identityKey, requestId: request.requestId }).update(row)
      else await trx(table).insert(row)
      if (this.requireSourceDrain) await reserveSnapshotArchiveOwner(trx, owner, this.guardedSources)
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
      await assignSnapshotArchiveOwner(trx, claim, writer.archiveId)
      await trx(table).where(claim).update({ state: 'capturing', archiveId: writer.archiveId })
      return writer
    })
  }

  /** A remote cancellation fences the next append in its atomic archive transaction. */
  async append(
    owner: SnapshotArchiveRequestOwner,
    writer: SnapshotArchiveWriter,
    page: Omit<SnapshotArchivePage, 'digest'>
  ): Promise<void> {
    const claim = { ...owner }
    const captured = { ...writer }
    await new KnexSnapshotArchiveStore(this.knex).append(captured, page, async trx => {
      const row = await this.owned(trx, claim)
      if (row.state !== 'capturing' || row.archiveId !== captured.archiveId) unavailable()
    })
  }

  /** Called only after the local source and its owned pool have physically closed. */
  async sourceClosed(owner: SnapshotArchiveRequestOwner): Promise<void> {
    const claim = { ...owner }
    await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      await releaseSnapshotArchiveOwner(trx, claim)
    })
  }

  async seal(owner: SnapshotArchiveRequestOwner, writer: SnapshotArchiveWriter): Promise<SnapshotArchiveManifest> {
    const claim = { ...owner }
    const captured = { ...writer }
    return await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      const row = await this.owned(trx, claim)
      if (!['capturing', 'ready'].includes(row.state) || row.archiveId !== captured.archiveId) unavailable()
      if (await hasSnapshotArchiveOwner(trx, { identityKey: row.identityKey, requestId: row.requestId }))
        throw new SnapshotArchiveCleanupPendingError()
      const manifest = await new KnexSnapshotArchiveStore(trx).seal(captured)
      await trx(table).where(claim).update({ state: 'ready' })
      return manifest
    })
  }

  /** Persist a bounded terminal fence before a delayed first admission can reserve resources. */
  async markCancellation(identityKey: string, input: unknown): Promise<void> {
    identity(identityKey)
    const request = parseSnapshotArchiveRequest(input)
    const requestJson = JSON.stringify(request)
    await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      const key = { identityKey, requestId: request.requestId }
      const existing: RequestRow | undefined = await trx(table).where(key).first()
      if (existing !== undefined) {
        if (existing.requestJson !== requestJson) unavailable()
        if (['claimed', 'capturing', 'ready'].includes(existing.state))
          await trx(table).where(key).update({ state: 'closed' })
        return
      }
      const now = await snapshotArchiveDatabaseNow(trx)
      // The immutable deadline already prevents a future first admission.
      if (request.notAfter <= now) return
      validateSnapshotArchiveRequest(request, now)
      await trx(table).where('expiresAt', '<=', now).where({ released: true }).delete()
      const retained: Array<Pick<RequestRow, 'identityKey'>> = await trx(table)
        .select('identityKey')
        .limit(snapshotArchiveRequestLimits.total)
      if (
        retained.length >= snapshotArchiveRequestLimits.total ||
        retained.filter(row => row.identityKey === identityKey).length >= snapshotArchiveRequestLimits.perProfile
      )
        throw new SnapshotResourceLimitError('Snapshot archive cancellation history is occupied')
      await trx(table).insert({
        ...key,
        claimToken: Utils.toHex(Random(32)),
        state: 'closed',
        requestJson,
        expiresAt: request.notAfter,
        reservedBytes: 0,
        archiveId: null,
        released: true
      })
    })
  }

  /** Fence only the retained exact reader tuple; absence cannot start another capture. */
  async markReaderCancellation(identityKey: string, input: unknown): Promise<void> {
    identity(identityKey)
    const request = parseSnapshotArchiveReaderRequest(input)
    await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      const key = { identityKey, requestId: request.requestId }
      const row: RequestRow | undefined = await trx(table).where(key).first()
      if (row === undefined) return
      if (row.requestJson !== JSON.stringify(request)) unavailable()
      // Explicit client cancellation acknowledges a terminal failure receipt too.
      // Until then, polling must still observe failed/resource-limited capture.
      await trx(table).where(key).update({ state: 'closed' })
    })
  }

  /** Retain failure receipts for polling; only closed/expired reader tuples may be collected early. */
  private async collectReader(k: Knex, row: RequestRow): Promise<void> {
    if (!row.released || !['closed', 'expired'].includes(row.state)) return
    const decoded: unknown = JSON.parse(row.requestJson)
    if (
      decoded === null ||
      typeof decoded !== 'object' ||
      Object.getOwnPropertyDescriptor(decoded, 'version')?.value !== 2
    )
      return
    const request = parseSnapshotArchiveReaderRequest(decoded)
    if (request.requestId !== row.requestId || request.notAfter !== Number(row.expiresAt)) unavailable()
    await k(table).where({ identityKey: row.identityKey, requestId: row.requestId, released: true }).delete()
  }

  async close(identityKey: string, requestId: string, state: SnapshotArchiveTerminalState = 'closed'): Promise<void> {
    identity(identityKey)
    identifier(requestId)
    await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      const row: RequestRow | undefined = await trx(table).where({ identityKey, requestId }).first()
      if (row !== undefined && ['offered', 'claimed', 'capturing', 'ready'].includes(row.state)) {
        await trx(table).where({ identityKey, requestId }).update({ state })
      }
    })
    await this.release(identityKey, requestId)
  }

  private async release(identityKey: string, requestId: string): Promise<void> {
    const archiveId = await this.knex.transaction(async trx => {
      const capacity = await lockSnapshotArchiveCapacity(trx)
      const row: RequestRow | undefined = await trx(table).where({ identityKey, requestId }).first()
      if (row === undefined || !['closed', 'failed', 'expired', 'resource-limited'].includes(row.state))
        return undefined
      if (row.released) {
        await this.collectReader(trx, row)
        return undefined
      }
      if (await hasSnapshotArchiveOwner(trx, { identityKey, requestId })) throw new SnapshotArchiveCleanupPendingError()
      if (row.archiveId !== null) return row.archiveId
      await trx('snapshot_archive_capacity')
        .where({ id: 1 })
        .update({
          archives: capacity.archives - 1,
          reservedBytes: Number(capacity.reservedBytes) - Number(row.reservedBytes)
        })
      await trx(table).where({ identityKey, requestId }).update({ released: true })
      await this.collectReader(trx, { ...row, released: true })
      return undefined
    })
    if (archiveId === undefined) return
    await new KnexSnapshotArchiveStore(this.knex).close(identityKey, archiveId)
    await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      const row: RequestRow | undefined = await trx(table).where({ identityKey, requestId, archiveId }).first()
      if (row === undefined) return
      await trx(table).where({ identityKey, requestId, archiveId }).update({ released: true })
      await this.collectReader(trx, { ...row, released: true })
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
      try {
        if (Number(row.expiresAt) <= now) await this.close(row.identityKey, row.requestId, 'expired')
        else await this.release(row.identityKey, row.requestId)
      } catch (error) {
        if (!(error instanceof SnapshotArchiveCleanupPendingError)) throw error
      }
    })
    await this.knex.transaction(async trx => {
      await lockSnapshotArchiveCapacity(trx)
      await trx(table).where('expiresAt', '<=', now).where({ released: true }).delete()
    })
  }
}
