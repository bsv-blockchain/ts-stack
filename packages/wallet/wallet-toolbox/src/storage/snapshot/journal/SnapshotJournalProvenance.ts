import { promiseFromSync } from '../../../utility/promiseFromSync'
import type { SnapshotJournalFieldProvenancePage } from './SnapshotJournalFieldTypes'
import {
  writeSnapshotJournalPayloadRow,
  readSnapshotJournalPayloadRow,
  snapshotJournalFieldCacheNames,
  beginSnapshotJournalFieldCache,
  readSnapshotJournalFieldCacheVersion,
  appendSnapshotJournalFieldCache,
  readSnapshotJournalFieldCacheChunk,
  sealSnapshotJournalFieldCache,
  retireSnapshotJournalFieldCache,
  collectSnapshotJournalFieldCacheVersion,
  type SnapshotJournalFieldCacheScope,
  type SnapshotJournalFieldCacheVersion
} from './SnapshotJournalNativePayload'
import type { StorageKnex } from '../../StorageKnex'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from '../../portable/Brc38WorkingAllocation'
import type { SnapshotJournalDestinationLimits, SnapshotJournalWriterAdmission } from './SnapshotJournalProvider'
import type { SnapshotJournalHashedFieldPage, SnapshotJournalHashedFieldDelta } from './SnapshotJournalFieldTypes'
import {
  assertRemoteSnapshotJournalFieldArchive,
  assertRemoteSnapshotJournalFieldFrame,
  type RemoteSnapshotJournalFieldArchive,
  type RemoteSnapshotJournalFieldFrame
} from './openRemoteSnapshotJournalFieldArchive'
import { parseSnapshotJournalFieldArchiveBinding } from './SnapshotJournalArchiveBinding'
import { snapshotJournalReceiptBinding } from './SnapshotJournalReceipt'
import { requireSnapshotJournalCapturedFrame } from './SnapshotJournalCapturedIdentities'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { snapshotJournalAssociationGeneration } from './SnapshotJournalLineage'
import { createHash } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { snapshotSyncTables } from '../SnapshotSync'
import type { SnapshotJournalDeltaPage } from './SnapshotJournalDeltaPage'
import {
  encodeSnapshotJournalDeltaFrame,
  decodeSnapshotJournalDeltaFrame,
  encodeSnapshotJournalFieldFrame,
  decodeSnapshotJournalFieldFrame
} from './SnapshotJournalDeltaFrame'
import { snapshotJournalIdentityLineage } from './SnapshotJournalIdentityLedger'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import {
  withSnapshotJournalDestinationWindowFence,
  withSnapshotJournalAcknowledgedWindowFence,
  withSnapshotJournalWindowCustodyFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

function currentSnapshotJournalOwnedWriter(
  ...args: Parameters<typeof import('./SnapshotJournalOwnedWriter').currentSnapshotJournalOwnedWriter>
) {
  return (
    require('./SnapshotJournalOwnedWriter') as typeof import('./SnapshotJournalOwnedWriter')
  ).currentSnapshotJournalOwnedWriter(...args)
}
function requireSnapshotJournalOwnedWriter(
  ...args: Parameters<typeof import('./SnapshotJournalOwnedWriter').requireSnapshotJournalOwnedWriter>
) {
  return (
    require('./SnapshotJournalOwnedWriter') as typeof import('./SnapshotJournalOwnedWriter')
  ).requireSnapshotJournalOwnedWriter(...args)
}
async function verifyProvenanceWriterSchema(k: Knex): Promise<void> {
  await (
    require('./SnapshotJournalDestinationSchema') as typeof import('./SnapshotJournalDestinationSchema')
  ).verifySnapshotJournalDestinationSchema(k)
  await (
    require('./SnapshotJournalLifecycle') as typeof import('./SnapshotJournalLifecycle')
  ).readSnapshotJournalCaptureConfiguration(k)
}

const table = 'snapshot_reconciliation_provenance'
const budgets = 'snapshot_reconciliation_provenance_budgets'
export interface SnapshotJournalProvenanceLimits {
  maximumProvenanceRows: number
  maximumProvenanceBytes: number
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or stale journal source provenance')
}
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
  return value
}
function sourceId(value: unknown): number {
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid()
  return value
}
function sourceIdProjection(k: Knex, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(incomingId as char)) BETWEEN 1 AND 17 AND incomingId BETWEEN ? AND ? THEN incomingId ELSE NULL END AS incomingId'
      : "CASE WHEN typeof(incomingId)='integer' AND incomingId BETWEEN ? AND ? THEN incomingId ELSE NULL END AS incomingId",
    [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  )
}
function bounded(k: Knex, field: string, maximum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, maximum, field, field]
  )
}

function provenancePayload(
  change: SnapshotJournalDeltaPage['changes'][number] | SnapshotJournalHashedFieldDelta,
  fieldMode: boolean
): Uint8Array {
  const { revision, id1, id2, exactText } = change.metadata,
    common = { table: 'syncStates' as const, examined: 1, complete: false, after: { revision, id1, id2, exactText } },
    fields =
      fieldMode && change.present
        ? (change as Extract<SnapshotJournalHashedFieldDelta, { present: true }>).fields
        : undefined
  if (fields !== undefined && Object.keys(fields).length > 0)
    return encodeSnapshotJournalFieldFrame(
      {
        ...common,
        changes: [change as SnapshotJournalHashedFieldDelta],
        metadataBytes: 0,
        fieldBytes: Object.values(fields).reduce((sum, field) => sum + field.bytes, 0)
      },
      { stream: 'scope', tableId: 7 }
    )
  return encodeSnapshotJournalDeltaFrame(
    {
      ...common,
      payloadBytes: 0,
      changes: [change.present ? { metadata: change.metadata, present: true, row: change.row } : change]
    },
    { stream: 'scope', tableId: 7 }
  )
}
async function provenanceFieldReservation(k: Knex, scope: { userId: number; lineage: string }): Promise<number> {
  // Historical standalone provenance fixtures have no auxiliary family.
  if (!(await k.schema.hasTable(snapshotJournalFieldCacheNames.budgets))) return 0
  const values: Array<{ reserved: unknown }> = await k(snapshotJournalFieldCacheNames.budgets)
    .where(scope)
    .select('reserved')
    .limit(2)
  if (values.length > 1) invalid()
  return values.length ? number(values[0].reserved) : 0
}
function provenanceCacheScope(
  k: Knex,
  scope: { userId: number; lineage: string },
  maximumBytes: number
): SnapshotJournalFieldCacheScope {
  const current = currentSnapshotJournalOwnedWriter(k)
  return { ...current, userId: scope.userId, lineage: scope.lineage, maximumBytes }
}
async function retireProvenanceFields(
  k: Knex,
  scope: { userId: number; lineage: string },
  incomingId: number,
  retain: readonly string[] = []
): Promise<void> {
  scope = { userId: scope.userId, lineage: scope.lineage }
  if (!(await k.schema.hasTable(snapshotJournalFieldCacheNames.versions))) return
  const versions: Array<{ versionId: string }> = await k(snapshotJournalFieldCacheNames.versions)
    .where({ ...scope, incomingId, linked: 1 })
    .select('versionId')
    .limit(65)
  if (versions.length > 64) invalid()
  if (!versions.length) return
  const budget: Array<{ maximumBytes: unknown }> = await k(snapshotJournalFieldCacheNames.budgets)
    .where(scope)
    .select('maximumBytes')
    .limit(2)
  if (budget.length !== 1) invalid()
  const owner = provenanceCacheScope(k, scope, number(budget[0].maximumBytes))
  for (const version of versions)
    if (!retain.includes(version.versionId))
      await retireSnapshotJournalFieldCache(
        k,
        owner,
        await readSnapshotJournalFieldCacheVersion(k, owner, version.versionId)
      )
}

function provenanceCustodyQuery(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint
) {
  return k(snapshotJournalFieldCacheNames.versions)
    .where({ userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding), linked: 0 })
    .andWhere(function () {
      this.where('state', 'RETIRING').orWhere({ sessionId: state.sessionId, windowBinding: state.binding })
    })
}
/** Called only under the actual retired/acknowledged window custody fence.
 * Linked acknowledged bytes survive; provisional and retired bytes are deleted
 * physically in bounded steps before releasing their full reservation. */
export async function hasSnapshotJournalProvenanceCustody(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint
): Promise<boolean> {
  return (await provenanceCustodyQuery(k, binding, state).select('versionId').limit(1)).length !== 0
}
export async function cleanupSnapshotJournalProvenanceCustody(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  maximumRows: number
): Promise<{ removed: number; complete: boolean }> {
  return await withSnapshotJournalWindowCustodyFence(k, binding, state, async k => {
    number(maximumRows, 33)
    if (maximumRows < 1) invalid()
    const versions: Array<{ versionId: string }> = await provenanceCustodyQuery(k, binding, state)
      .select('versionId')
      .orderBy('versionId')
      .limit(1)
    if (!versions.length) return { removed: 0, complete: true }
    const key = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) },
      counts: Array<{ maximumBytes: unknown }> = await k(snapshotJournalFieldCacheNames.budgets)
        .where(key)
        .select('maximumBytes')
        .limit(2)
    if (counts.length !== 1) invalid()
    const scope = provenanceCacheScope(k, key, number(counts[0].maximumBytes))
    let header = await readSnapshotJournalFieldCacheVersion(k, scope, versions[0].versionId)
    if (header.linked !== 0) invalid()
    if (header.state !== 'RETIRING') header = await retireSnapshotJournalFieldCache(k, scope, header)
    const chunks: Array<{ byteOffset: unknown }> = await k(snapshotJournalFieldCacheNames.chunks)
        .where('versionId', header.versionId)
        .select('byteOffset')
        .orderBy('byteOffset')
        .limit(Math.min(32, maximumRows)),
      deleted = await collectSnapshotJournalFieldCacheVersion(k, scope, header, maximumRows)
    return {
      removed: chunks.length + (deleted ? 1 : 0),
      complete: !(await hasSnapshotJournalProvenanceCustody(k, binding, state))
    }
  })
}

/** A format transition at the SAME source revision requires logical equality.
 * The raw decoder stays strict: no missing-field DTO is returned to its caller. */
async function requireEquivalentProvenanceEncoding(
  k: Knex,
  key: { userId: number; lineage: string; incomingId: number },
  old: Record<string, unknown>,
  replacement: Uint8Array
): Promise<void> {
  const payload = await readSnapshotJournalPayloadRow(
    k,
    table,
    { ...key, revision: old.revision, sourceGeneration: old.sourceGeneration, bytes: old.bytes, digest: old.digest },
    number(old.bytes, 1048576)
  )
  try {
    if (createHash('sha256').update(payload).digest('hex') !== old.digest) invalid()
    const decode = (bytes: Uint8Array) => {
        try {
          return { field: true as const, page: decodeSnapshotJournalFieldFrame(bytes, { stream: 'scope', tableId: 7 }) }
        } catch {
          return {
            field: false as const,
            page: decodeSnapshotJournalDeltaFrame(bytes, { stream: 'scope', tableId: 7 })
          }
        }
      },
      left = decode(payload),
      right = decode(replacement)
    if (left.field === right.field) invalid()
    const field = (left.field ? left.page : right.page) as SnapshotJournalHashedFieldPage,
      raw = (left.field ? right.page : left.page) as SnapshotJournalDeltaPage,
      f = field.changes[0],
      r = raw.changes[0]
    if (field.changes.length !== 1 || raw.changes.length !== 1 || !f.present || !r.present) invalid()
    const row = { ...r.row }
    for (const [name, descriptor] of Object.entries(f.fields)) {
      const value = row[name]
      if (descriptor.kind === 'utf8' ? typeof value !== 'string' : !(value instanceof Uint8Array)) invalid()
      const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : (value as Uint8Array)
      try {
        if (bytes.length !== descriptor.bytes || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256)
          invalid()
      } finally {
        if (typeof value === 'string') bytes.fill(0)
      }
      delete row[name]
    }
    const normalized = provenancePayload({ ...r, row, fields: f.fields }, true),
      target = left.field ? payload : replacement
    try {
      if (Buffer.compare(normalized, target) !== 0) invalid()
    } finally {
      normalized.fill(0)
    }
  } finally {
    payload.fill(0)
  }
}

const applyingFieldProvenance = new WeakMap<
  PreparedSnapshotJournalFieldProvenance,
  (trx: Knex, index: number, digest: string) => Promise<void>
>()
const preparedFieldProvenance = new WeakSet<PreparedSnapshotJournalFieldProvenance>()
/** Actual archive/frame + destination-root owner. SQL headers and descriptors
 * remain DATA; only a full source hash and independent stored EOF hash issue
 * this single-use preparation. No SQL writer is held across an HTTP read. */
export class PreparedSnapshotJournalFieldProvenance {
  readonly #storage: StorageKnex
  readonly #binding: SnapshotJournalDestinationBinding
  readonly #expected: SnapshotJournalDestinationCheckpoint
  readonly #archive: RemoteSnapshotJournalFieldArchive
  readonly #frame: RemoteSnapshotJournalFieldFrame
  readonly #limits: SnapshotJournalDestinationLimits
  readonly #admission: SnapshotJournalWriterAdmission
  readonly #signal: AbortSignal | undefined

  #used = false
  #applying = false
  readonly #versions = new Map<number, Readonly<SnapshotJournalFieldCacheVersion>[]>()
  readonly #root: Knex
  readonly #scope: SnapshotJournalFieldCacheScope
  readonly #deadline: number
  readonly #expiresAt: number
  #charge?: Brc38WorkingCharge
  private constructor(
    storage: StorageKnex,
    binding: SnapshotJournalDestinationBinding,
    expected: SnapshotJournalDestinationCheckpoint,
    archive: RemoteSnapshotJournalFieldArchive,
    frame: RemoteSnapshotJournalFieldFrame,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal
  ) {
    this.#storage = storage
    this.#binding = binding
    this.#expected = expected
    this.#archive = archive
    this.#frame = frame
    this.#limits = limits
    this.#admission = admission
    this.#signal = signal

    this.#root = storage.knex
    this.#scope = {
      root: this.#root,
      backend: binding.destinationBackend,
      userId: binding.destinationUserId,
      lineage: snapshotJournalIdentityLineage(binding),
      maximumBytes: limits.maximumProvenanceBytes
    }
    this.#expiresAt = Math.min(archive.expiresAt, binding.receipt.expiresAt)
    this.#deadline = performance.now() + this.#expiresAt - Date.now()
  }
  #current(): void {
    this.#signal?.throwIfAborted()
    assertRemoteSnapshotJournalFieldFrame(this.#archive, this.#frame)
    const source = parseSnapshotJournalFieldArchiveBinding(this.#archive.manifest.binding)
    if (
      this.#storage.knex !== this.#root ||
      Date.now() >= this.#expiresAt ||
      performance.now() >= this.#deadline ||
      this.#expected.phase !== 'intake' ||
      this.#expected.streamIndex !== 7 ||
      this.#frame.ordinal !== this.#expected.sequence ||
      this.#frame.stream !== 'scope' ||
      this.#frame.tableId !== 7 ||
      this.#binding.fieldEncoding !== 'wallet-journal-fields/1' ||
      source.user.identityKey !== this.#binding.source.identityKey ||
      snapshotJournalReceiptBinding(source.journal.source) !== snapshotJournalReceiptBinding(this.#binding.source) ||
      JSON.stringify(source.journal.receipt) !== JSON.stringify(this.#binding.receipt) ||
      source.journal.low !== this.#binding.low ||
      source.journal.bootstrap !== (this.#binding.bootstrap === true)
    )
      invalid()
  }
  async #writer<T>(apply: (trx: Knex) => Promise<T>): Promise<T> {
    this.#current()
    return await this.#admission(
      async () =>
        await this.#storage.runSnapshotJournalWriter(
          async (trx, backend) => {
            this.#current()
            if (backend !== this.#scope.backend) invalid()
            requireSnapshotJournalOwnedWriter(trx, this.#root, backend)
            await verifyProvenanceWriterSchema(trx)
            return await withSnapshotJournalDestinationWindowFence(trx, this.#binding, this.#expected, async fenced => {
              const result = await apply(fenced)
              this.#current()
              return result
            })
          },
          this.#scope.backend,
          this.#signal
        )
    )
  }
  static async prepare(
    storage: StorageKnex,
    binding: SnapshotJournalDestinationBinding,
    expected: SnapshotJournalDestinationCheckpoint,
    archive: RemoteSnapshotJournalFieldArchive,
    frame: RemoteSnapshotJournalFieldFrame,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal
  ): Promise<PreparedSnapshotJournalFieldProvenance> {
    assertRemoteSnapshotJournalFieldArchive(archive)
    assertRemoteSnapshotJournalFieldFrame(archive, frame)
    const owner = new PreparedSnapshotJournalFieldProvenance(
      storage,
      JSON.parse(JSON.stringify(binding)),
      JSON.parse(JSON.stringify(expected)),
      archive,
      frame,
      { ...limits },
      admission,
      signal
    )
    owner.#current()
    const page = frame.page,
      encoded = encodeSnapshotJournalFieldFrame(page, { stream: 'scope', tableId: 7 }),
      allocation = new Brc38WorkingAllocation(limits.maximumAllocationBytes)
    try {
      owner.#charge = allocation.claim(
        16 * encoded.length +
          65536 +
          page.changes.reduce((sum, change) => sum + (change.present ? Object.keys(change.fields).length * 2048 : 0), 0)
      )
      if (createHash('sha256').update(encoded).digest('hex') !== frame.frameDigest) invalid()
      for (const [index, change] of page.changes.entries()) {
        if (!change.present) continue
        if (change.row.userId !== binding.source.userId) invalid()
        const versions: Readonly<SnapshotJournalFieldCacheVersion>[] = []
        for (const [fieldName, descriptor] of Object.entries(change.fields)) {
          let header = await owner.#writer(
            async trx =>
              await beginSnapshotJournalFieldCache(trx, owner.#scope, {
                userId: owner.#scope.userId,
                lineage: owner.#scope.lineage,
                sourceStorageIdentity: binding.source.storageIdentity,
                sessionId: expected.sessionId,
                windowBinding: expected.binding,
                frameDigest: frame.frameDigest,
                changeIndex: index,
                incomingId: change.metadata.id1,
                sourceGeneration: snapshotJournalAssociationGeneration(binding),
                sourceRevision: change.metadata.revision,
                fieldName,
                kind: descriptor.kind,
                bytes: descriptor.bytes,
                sha256: descriptor.sha256,
                expiresAt: owner.#expiresAt
              })
          )
          if (header.state === 'PENDING') {
            const sourceHash = createHash('sha256')
            let offset = 0
            while (offset < descriptor.bytes) {
              owner.#current()
              const length = Math.min(
                  16384,
                  descriptor.bytes - offset,
                  offset < header.accepted ? header.accepted - offset : 16384
                ),
                bytes = await archive.readFieldExtent(frame, index, fieldName, offset, length)
              try {
                if (bytes.length !== length) invalid()
                sourceHash.update(bytes)
                if (offset < header.accepted) {
                  const previous = await owner.#writer(
                    async trx => await readSnapshotJournalFieldCacheChunk(trx, owner.#scope, header, offset)
                  )
                  try {
                    if (previous.nextOffset !== offset + length || Buffer.compare(previous.bytes, bytes) !== 0)
                      invalid()
                  } finally {
                    previous.bytes.fill(0)
                  }
                } else
                  header = await owner.#writer(
                    async trx => await appendSnapshotJournalFieldCache(trx, owner.#scope, header, bytes)
                  )
                offset += length
              } finally {
                bytes.fill(0)
              }
            }
            if (sourceHash.digest('hex') !== descriptor.sha256) invalid()
          }
          const eof = await archive.readFieldExtent(frame, index, fieldName, descriptor.bytes, 0)
          try {
            if (eof.length !== 0) invalid()
          } finally {
            eof.fill(0)
          }
          const storedHash = createHash('sha256')
          let offset = 0
          for (;;) {
            const chunk = await owner.#writer(
              async trx => await readSnapshotJournalFieldCacheChunk(trx, owner.#scope, header, offset)
            )
            try {
              if (chunk.bytes.length === 0) break
              storedHash.update(chunk.bytes)
              offset = chunk.nextOffset
            } finally {
              chunk.bytes.fill(0)
            }
          }
          if (offset !== descriptor.bytes || storedHash.digest('hex') !== descriptor.sha256) invalid()
          if (header.state === 'PENDING')
            header = await owner.#writer(async trx => await sealSnapshotJournalFieldCache(trx, owner.#scope, header))
          if (header.state !== 'SEALED' || header.accepted !== descriptor.bytes) invalid()
          versions.push(header)
        }
        owner.#versions.set(index, versions)
      }
      owner.#current()
      preparedFieldProvenance.add(owner)
      return owner
    } catch (cause) {
      owner.close()
      throw cause
    } finally {
      encoded.fill(0)
    }
  }
  close(): void {
    this.#used = true
    preparedFieldProvenance.delete(this)
    this.#versions.clear()
    this.#charge?.close()
    this.#charge = undefined
  }
  async apply(trx: Knex): Promise<void> {
    if (!preparedFieldProvenance.has(this) || this.#used) invalid()
    this.#current()
    requireSnapshotJournalOwnedWriter(trx, this.#root, this.#scope.backend)
    await requireSnapshotJournalCapturedFrame(
      trx,
      this.#binding,
      this.#expected,
      this.#frame.frameDigest,
      this.#frame.page.changes.length
    )
    this.#used = true
    this.#applying = true
    applyingFieldProvenance.set(this, async (trx, index, digest) => await this.#link(trx, index, digest))
    try {
      await applyProvenancePage(trx, this.#binding, this.#expected, this.#frame.page, this.#limits, this)
      this.#current()
    } finally {
      this.#applying = false
      applyingFieldProvenance.delete(this)
    }
  }
  /** Internal commit step: available only within this object's fenced apply. */
  async #link(trx: Knex, index: number, digest: string): Promise<void> {
    if (!this.#applying || !preparedFieldProvenance.has(this)) invalid()
    this.#current()
    requireSnapshotJournalOwnedWriter(trx, this.#root, this.#scope.backend)
    const change = this.#frame.page.changes[index]
    if (!change?.present) invalid()
    const versions = this.#versions.get(index) ?? []
    await retireProvenanceFields(
      trx,
      this.#scope,
      change.metadata.id1,
      versions.map(value => value.versionId)
    )
    for (const version of versions) {
      const actual = await readSnapshotJournalFieldCacheVersion(trx, this.#scope, version.versionId)
      if (JSON.stringify(actual) !== JSON.stringify(version)) invalid()
      if (
        (await trx(snapshotJournalFieldCacheNames.versions)
          .where({ versionId: version.versionId, revision: version.revision, state: 'SEALED' })
          .update({ linked: 1, recordDigest: digest, revision: trx.raw('revision+1') })) !== 1
      )
        invalid()
    }
  }
}
export function snapshotJournalProvenanceDdl(k: Knex): string[] {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  if (!mysql && !['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) && !isOwnedNativeSqlite(k))
    invalid()
  const suffix = mysql ? ' ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC' : ''
  return [
    'CREATE TABLE ' +
      budgets +
      '(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,maximumRows INTEGER NOT NULL,maximumBytes BIGINT NOT NULL,`rows` INTEGER NOT NULL,bytes BIGINT NOT NULL,PRIMARY KEY(userId,lineage))' +
      suffix,
    'CREATE TABLE ' +
      table +
      '(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,incomingId BIGINT NOT NULL,revision VARCHAR(19) NOT NULL,bytes INTEGER NOT NULL,digest VARCHAR(64) NOT NULL,seenSession VARCHAR(64) NOT NULL,sourceGeneration VARCHAR(64) NOT NULL,payload ' +
      (mysql ? 'LONGBLOB' : 'BLOB') +
      ' NOT NULL,PRIMARY KEY(userId,lineage,incomingId))' +
      suffix,
    'CREATE INDEX snapshot_reconciliation_provenance_scan ON ' + table + '(userId,lineage,seenSession,incomingId)'
  ]
}

/** Preserve original operational sync-state cells separately from destination
 * checkpoints. They are never applied to native sync_states or user activation.
 * Raw frame bytes retain null/history/binary/source IDs exactly. */
export async function applySnapshotJournalProvenancePage(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  page: SnapshotJournalDeltaPage,
  limits: SnapshotJournalProvenanceLimits
): Promise<void> {
  return await applyProvenancePage(k, binding, expected, page, limits)
}

async function applyProvenancePage(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  page: SnapshotJournalDeltaPage | SnapshotJournalHashedFieldPage,
  limits: SnapshotJournalProvenanceLimits,
  prepared?: PreparedSnapshotJournalFieldProvenance
): Promise<void> {
  if (page.table !== 'syncStates') invalid()
  // Validate the complete source page before allocating/storing individual rows.
  if (prepared === undefined)
    encodeSnapshotJournalDeltaFrame(page as SnapshotJournalDeltaPage, { stream: 'scope', tableId: 7 })
  else encodeSnapshotJournalFieldFrame(page as SnapshotJournalHashedFieldPage, { stream: 'scope', tableId: 7 })
  const maximumRows = number(limits.maximumProvenanceRows, 2147483647)
  const maximumBytes = number(limits.maximumProvenanceBytes)
  if (maximumRows < 1 || maximumBytes < 1) invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    const counts: Array<Record<string, unknown>> = await trx(budgets)
      .where(scope)
      .select(
        bounded(trx, 'maximumRows', 2147483647, mysql),
        bounded(trx, 'maximumBytes', Number.MAX_SAFE_INTEGER, mysql),
        bounded(trx, 'rows', maximumRows, mysql),
        bounded(trx, 'bytes', maximumBytes, mysql)
      )
      .limit(2)
    if (counts.length > 1) invalid()
    if (!counts.length) {
      if ((await trx(table).where(scope).select('incomingId').limit(1)).length) invalid()
      await trx(budgets).insert({ ...scope, maximumRows, maximumBytes, rows: 0, bytes: 0 })
    } else if (number(counts[0].maximumRows) !== maximumRows || number(counts[0].maximumBytes) !== maximumBytes)
      invalid()
    const initial = {
      rows: counts.length ? number(counts[0].rows) : 0,
      bytes: counts.length ? number(counts[0].bytes) : 0
    }
    let rows = initial.rows,
      bytes = initial.bytes
    const fieldReserved = await provenanceFieldReservation(trx, scope)
    for (const [changeIndex, change] of page.changes.entries()) {
      const key = { ...scope, incomingId: change.metadata.id1 }
      const old: Array<Record<string, unknown>> = await trx(table)
        .where(key)
        .select(
          trx.raw('substr(sourceGeneration,1,65) AS sourceGeneration'),
          bounded(trx, 'bytes', 1048576, mysql),
          trx.raw(
            mysql
              ? 'CASE WHEN octet_length(revision) BETWEEN 1 AND 19 THEN revision ELSE NULL END AS revision'
              : "CASE WHEN typeof(revision)='text' AND length(revision) BETWEEN 1 AND 19 THEN revision ELSE NULL END AS revision"
          ),
          trx.raw(
            mysql
              ? 'CASE WHEN octet_length(digest)=64 THEN digest ELSE NULL END AS digest'
              : "CASE WHEN typeof(digest)='text' AND length(digest)=64 THEN digest ELSE NULL END AS digest"
          )
        )
        .limit(2)
      if (
        old.length > 1 ||
        (old.length &&
          (typeof old[0].digest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(old[0].digest) ||
            typeof old[0].sourceGeneration !== 'string' ||
            !/^[0-9a-f]{64}$/.test(old[0].sourceGeneration)))
      )
        invalid()
      const sourceGeneration = snapshotJournalAssociationGeneration(binding)
      const currentGeneration = old.length > 0 && old[0].sourceGeneration === sourceGeneration
      if (old.length) snapshotJournalRevision(old[0].revision)
      if (
        currentGeneration &&
        compareSnapshotJournalRevisions(snapshotJournalRevision(old[0].revision), change.metadata.revision) > 0
      )
        invalid()
      const previousBytes = old.length ? number(old[0].bytes, 1048576) : 0
      if (!change.present) {
        if (old.length) {
          await retireProvenanceFields(trx, scope, change.metadata.id1)
          if (
            (await trx(table)
              .where({
                ...key,
                sourceGeneration: old[0].sourceGeneration,
                revision: old[0].revision,
                bytes: previousBytes,
                digest: old[0].digest
              })
              .delete()) !== 1
          )
            invalid()
          rows--
          bytes -= previousBytes
        }
        continue
      }
      if (Number(change.row.userId) !== binding.source.userId) invalid()
      const { revision, id1 } = change.metadata
      const payload = provenancePayload(change, prepared !== undefined)
      try {
        const digest = createHash('sha256').update(payload).digest('hex')
        const replacement = {
          revision,
          sourceGeneration,
          bytes: payload.byteLength,
          digest,
          seenSession: expected.sessionId
        }
        if (currentGeneration && old[0].revision === revision && old[0].digest !== digest)
          await requireEquivalentProvenanceEncoding(trx, key, old[0], payload)
        if (!old.length) rows++
        bytes += payload.byteLength - previousBytes
        if (rows > maximumRows || bytes > maximumBytes - fieldReserved)
          throw new SnapshotResourceLimitError('Source provenance exceeds negotiated durable capacity')
        if (prepared === undefined) await retireProvenanceFields(trx, scope, id1)
        else {
          const link = applyingFieldProvenance.get(prepared)
          if (link === undefined) invalid()
          await link(trx, changeIndex, digest)
        }
        await writeSnapshotJournalPayloadRow(
          trx,
          table,
          key,
          replacement,
          payload,
          old.length
            ? {
                sourceGeneration: old[0].sourceGeneration,
                revision: old[0].revision,
                bytes: previousBytes,
                digest: old[0].digest
              }
            : undefined
        )
      } finally {
        payload.fill(0)
      }
    }
    if (
      rows < 0 ||
      bytes < 0 ||
      (await trx(budgets)
        .where({ ...scope, maximumRows, maximumBytes, ...initial })
        .update({ rows, bytes })) !== 1
    )
      invalid()
  })
}

/** Remove missing operational records only after a complete current-state scan.
 * Payloads are not loaded for this bounded cleanup; native sync/primary values
 * remain untouched. Counters and removals share the destination writer. */
export async function cleanupUnseenSnapshotJournalProvenance(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint
): Promise<boolean> {
  if (
    binding.bootstrap !== true ||
    expected.phase !== 'promoting' ||
    expected.tableIndex !== snapshotSyncTables.length - 1
  )
    invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    const query = trx
      .from(
        trx.raw(
          mysql
            ? table + ' FORCE INDEX (snapshot_reconciliation_provenance_scan)'
            : table + ' INDEXED BY snapshot_reconciliation_provenance_scan'
        )
      )
      .where(scope)
      .whereNot('seenSession', expected.sessionId)
      .select(
        sourceIdProjection(trx, mysql),
        bounded(trx, 'bytes', 1048576, mysql),
        trx.raw('substr(seenSession,1,65) AS seenSession')
      )
      .orderBy(['seenSession', 'incomingId'])
      .limit(32)
    if (mysql) query.forUpdate().noWait()
    const rows: Array<Record<string, unknown>> = await query
    if (rows.length) {
      const countRows: Array<Record<string, unknown>> = await trx(budgets)
        .where(scope)
        .select(bounded(trx, 'rows', 2147483647, mysql), bounded(trx, 'bytes', Number.MAX_SAFE_INTEGER, mysql))
        .limit(2)
      if (countRows.length !== 1) invalid()
      const previous = { rows: number(countRows[0].rows), bytes: number(countRows[0].bytes) }
      let removedBytes = 0
      for (const row of rows) {
        const incomingId = sourceId(row.incomingId),
          bytes = number(row.bytes, 1048576)
        if (
          typeof row.seenSession !== 'string' ||
          !/^[0-9a-f]{64}$/.test(row.seenSession) ||
          row.seenSession === expected.sessionId
        )
          invalid()
        await retireProvenanceFields(trx, scope, incomingId)
        if (
          (await trx(table)
            .where({ ...scope, incomingId, bytes, seenSession: row.seenSession })
            .delete()) !== 1
        )
          invalid()
        removedBytes += bytes
      }
      if (
        previous.rows < rows.length ||
        previous.bytes < removedBytes ||
        (await trx(budgets)
          .where({ ...scope, ...previous })
          .update({ rows: previous.rows - rows.length, bytes: previous.bytes - removedBytes })) !== 1
      )
        invalid()
    }
    return !(await trx(table).where(scope).whereNot('seenSession', expected.sessionId).select('incomingId').limit(1))
      .length
  })
}

export interface SnapshotJournalProvenancePage {
  rows: ReadonlyArray<{ incomingId: number; revision: string; raw: Readonly<Record<string, unknown>> }>
  after?: number
  complete: boolean
  payloadBytes: number
}
export type { SnapshotJournalFieldProvenancePage } from './SnapshotJournalFieldTypes'

/** Read original source rows after durable acknowledgement, in bounded keyset
 * pages. Authenticated provider/profile/backend checks belong to the actual
 * owning writer; the ACK fence rechecks that profile and exact durable window.
 * Every payload is size-checked before SQL selection, then hash/codec checked.
 * No native sync cursor or primary is substituted for these original cells. */
export async function readSnapshotJournalProvenancePage(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  after?: number,
  maximumRows = 32,
  maximumBytes = 1048576
): Promise<SnapshotJournalProvenancePage> {
  const page = await readProvenanceRecords(k, binding, expected, after, maximumRows, maximumBytes, false)
  return {
    ...page,
    rows: page.rows.map(row => ({ incomingId: row.incomingId, revision: row.revision, raw: row.small }))
  }
}

/** Explicit small cells + field descriptors, never a partial complete-row DTO. */
export async function readSnapshotJournalFieldProvenancePage(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  after?: number,
  maximumRows = 32,
  maximumBytes = 1048576
): Promise<SnapshotJournalFieldProvenancePage> {
  return await readProvenanceRecords(k, binding, expected, after, maximumRows, maximumBytes, true)
}

async function readProvenanceRecords(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  after: number | undefined,
  maximumRows: number,
  maximumBytes: number,
  fieldAware: boolean
): Promise<SnapshotJournalFieldProvenancePage> {
  if (after !== undefined) sourceId(after)
  if (
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > 64 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 1048576
  )
    invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return await withSnapshotJournalAcknowledgedWindowFence(k, binding, expected, async trx => {
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    const query = trx(table)
      .where(scope)
      .select(
        sourceIdProjection(trx, mysql),
        bounded(trx, 'bytes', 1048576, mysql),
        trx.raw('substr(digest,1,65) AS digest'),
        trx.raw('substr(revision,1,20) AS revision'),
        trx.raw('substr(sourceGeneration,1,65) AS sourceGeneration')
      )
      .orderBy('incomingId')
      .limit(maximumRows)
    if (after !== undefined) query.where('incomingId', '>', after)
    const metadata: Array<Record<string, unknown>> = await query
    let payloadBytes = 0,
      previousId = after
    const rows: SnapshotJournalFieldProvenancePage['rows'][number][] = []
    for (const record of metadata) {
      const incomingId = sourceId(record.incomingId),
        bytes = number(record.bytes, 1048576),
        revision = snapshotJournalRevision(record.revision)
      if (
        (previousId !== undefined && incomingId <= previousId) ||
        bytes < 1 ||
        typeof record.digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record.digest) ||
        record.sourceGeneration !== snapshotJournalAssociationGeneration(binding) ||
        compareSnapshotJournalRevisions(revision, binding.receipt.highWater) > 0
      )
        invalid()
      if (bytes > maximumBytes - payloadBytes) {
        if (!rows.length) throw new SnapshotResourceLimitError('Source provenance row exceeds its page byte allowance')
        break
      }
      const payload = await readSnapshotJournalPayloadRow(
        trx,
        table,
        { ...scope, incomingId, bytes, digest: record.digest, revision, sourceGeneration: record.sourceGeneration },
        bytes
      )
      if (createHash('sha256').update(payload).digest('hex') !== record.digest) {
        payload.fill(0)
        invalid()
      }
      let page: SnapshotJournalDeltaPage | SnapshotJournalHashedFieldPage
      try {
        if (fieldAware) {
          try {
            page = decodeSnapshotJournalFieldFrame(payload, { stream: 'scope', tableId: 7 })
          } catch {
            page = decodeSnapshotJournalDeltaFrame(payload, { stream: 'scope', tableId: 7 })
          }
        } else page = decodeSnapshotJournalDeltaFrame(payload, { stream: 'scope', tableId: 7 })
      } finally {
        payload.fill(0)
      }
      if (
        page.table !== 'syncStates' ||
        page.changes.length !== 1 ||
        !page.changes[0].present ||
        page.changes[0].metadata.id1 !== incomingId ||
        page.changes[0].metadata.revision !== revision ||
        Number(page.changes[0].row.userId) !== binding.source.userId
      )
        invalid()
      rows.push({
        incomingId,
        revision,
        small: Object.freeze({ ...page.changes[0].row }),
        fields: Object.freeze({ ...Reflect.get(page.changes[0], 'fields') })
      })
      payloadBytes += bytes
      previousId = incomingId
    }
    const remaining = trx(table).where(scope)
    if (previousId !== undefined) remaining.where('incomingId', '>', previousId)
    const more = await remaining.select('incomingId').limit(1)
    return { rows, ...(rows.length ? { after: previousId } : {}), complete: more.length === 0, payloadBytes }
  })
}

const openedProvenanceFields = new WeakSet<SnapshotJournalProvenanceFieldReader>()
/** Rehash an acknowledged linked field to EOF using short actual destination
 * views, then expose bounded extents under that same revision/profile/ACK.
 * Archive expiry does not discard durable provenance. This reader is neither
 * WalletReadSnapshot nor an SQL/source/primary actor. */
export class SnapshotJournalProvenanceFieldReader {
  readonly #storage: StorageKnex
  readonly #binding: SnapshotJournalDestinationBinding
  readonly #expected: SnapshotJournalDestinationCheckpoint
  readonly #incomingId: number
  readonly #fieldName: string
  readonly #admission: SnapshotJournalWriterAdmission
  readonly #signal: AbortSignal | undefined

  readonly #root: Knex
  readonly #charge: Brc38WorkingCharge
  #header?: Readonly<SnapshotJournalFieldCacheVersion>
  #closed = false
  readonly #maximumMetadataBytes: number
  private constructor(
    storage: StorageKnex,
    binding: SnapshotJournalDestinationBinding,
    expected: SnapshotJournalDestinationCheckpoint,
    incomingId: number,
    fieldName: string,
    admission: SnapshotJournalWriterAdmission,
    maximumAllocationBytes: number,
    signal?: AbortSignal
  ) {
    this.#storage = storage
    this.#binding = binding
    this.#expected = expected
    this.#incomingId = incomingId
    this.#fieldName = fieldName
    this.#admission = admission
    this.#signal = signal

    this.#root = storage.knex
    this.#charge = new Brc38WorkingAllocation(maximumAllocationBytes).claim(maximumAllocationBytes)
    this.#maximumMetadataBytes = Math.min(1048576, Math.floor((maximumAllocationBytes - 131072) / 16))
    if (this.#maximumMetadataBytes < 1) {
      this.#charge.close()
      invalid()
    }
  }
  #current(): void {
    this.#signal?.throwIfAborted()
    if (this.#closed || this.#storage.knex !== this.#root || this.#expected.phase !== 'acknowledged') invalid()
  }
  async #writer<T>(
    apply: (
      trx: Knex,
      scope: SnapshotJournalFieldCacheScope,
      header: Readonly<SnapshotJournalFieldCacheVersion>
    ) => Promise<T>
  ): Promise<T> {
    this.#current()
    return await this.#admission(
      async () =>
        await this.#storage.runSnapshotJournalWriter(
          async (trx, backend) => {
            this.#current()
            if (backend !== this.#binding.destinationBackend) invalid()
            requireSnapshotJournalOwnedWriter(trx, this.#root, backend)
            await verifyProvenanceWriterSchema(trx)
            return await withSnapshotJournalAcknowledgedWindowFence(
              trx,
              this.#binding,
              this.#expected,
              async fenced => {
                const page = await readProvenanceRecords(
                    fenced,
                    this.#binding,
                    this.#expected,
                    this.#incomingId === -Number.MAX_SAFE_INTEGER ? undefined : this.#incomingId - 1,
                    1,
                    this.#maximumMetadataBytes,
                    true
                  ),
                  row = page.rows[0],
                  descriptor = row?.fields[this.#fieldName],
                  key = {
                    userId: this.#binding.destinationUserId,
                    lineage: snapshotJournalIdentityLineage(this.#binding)
                  }
                if (row?.incomingId !== this.#incomingId || descriptor === undefined) invalid()
                const records: Array<{ digest: unknown }> = await fenced(table)
                    .where({ ...key, incomingId: this.#incomingId, revision: row.revision })
                    .select('digest')
                    .limit(2),
                  budgets: Array<{ maximumBytes: unknown }> = await fenced(snapshotJournalFieldCacheNames.budgets)
                    .where(key)
                    .select('maximumBytes')
                    .limit(2)
                if (
                  records.length !== 1 ||
                  budgets.length !== 1 ||
                  typeof records[0].digest !== 'string' ||
                  !/^[0-9a-f]{64}$/.test(records[0].digest)
                )
                  invalid()
                const versions: Array<{ versionId: string }> = await fenced(snapshotJournalFieldCacheNames.versions)
                  .where({ ...key, incomingId: this.#incomingId, fieldName: this.#fieldName, linked: 1 })
                  .select('versionId')
                  .limit(2)
                if (versions.length !== 1) invalid()
                const scope: SnapshotJournalFieldCacheScope = {
                    root: this.#root,
                    backend,
                    ...key,
                    maximumBytes: number(budgets[0].maximumBytes)
                  },
                  header = await readSnapshotJournalFieldCacheVersion(fenced, scope, versions[0].versionId)
                if (
                  header.sourceStorageIdentity !== this.#binding.source.storageIdentity ||
                  header.sourceGeneration !== snapshotJournalAssociationGeneration(this.#binding) ||
                  header.sourceRevision !== row.revision ||
                  header.recordDigest !== records[0].digest ||
                  header.kind !== descriptor.kind ||
                  header.bytes !== descriptor.bytes ||
                  header.sha256 !== descriptor.sha256 ||
                  header.state !== 'SEALED' ||
                  header.accepted !== header.bytes ||
                  (this.#header !== undefined && JSON.stringify(this.#header) !== JSON.stringify(header))
                )
                  invalid()
                const result = await apply(fenced, scope, header)
                this.#current()
                return result
              }
            )
          },
          this.#binding.destinationBackend,
          this.#signal
        )
    )
  }
  static async open(
    storage: StorageKnex,
    binding: SnapshotJournalDestinationBinding,
    expected: SnapshotJournalDestinationCheckpoint,
    incomingId: number,
    fieldName: string,
    admission: SnapshotJournalWriterAdmission,
    maximumAllocationBytes = 16777216,
    signal?: AbortSignal
  ): Promise<SnapshotJournalProvenanceFieldReader> {
    sourceId(incomingId)
    if (typeof fieldName !== 'string' || Buffer.byteLength(fieldName) < 1 || Buffer.byteLength(fieldName) > 64)
      invalid()
    const owner = new SnapshotJournalProvenanceFieldReader(
      storage,
      JSON.parse(JSON.stringify(binding)),
      JSON.parse(JSON.stringify(expected)),
      incomingId,
      fieldName,
      admission,
      maximumAllocationBytes,
      signal
    )
    try {
      owner.#header = await owner.#writer((_trx, _scope, header) => promiseFromSync(() => header))
      const hash = createHash('sha256')
      let offset = 0
      for (;;) {
        const chunk = await owner.#writer(
          async (trx, scope, header) => await readSnapshotJournalFieldCacheChunk(trx, scope, header, offset)
        )
        try {
          if (chunk.bytes.length === 0) break
          hash.update(chunk.bytes)
          offset = chunk.nextOffset
        } finally {
          chunk.bytes.fill(0)
        }
      }
      if (offset !== owner.#header.bytes || hash.digest('hex') !== owner.#header.sha256) invalid()
      openedProvenanceFields.add(owner)
      return owner
    } catch (cause) {
      owner.close()
      throw cause
    }
  }
  get descriptor(): Readonly<{ kind: 'binary' | 'utf8'; bytes: number; sha256: string }> {
    if (!openedProvenanceFields.has(this) || this.#header === undefined) invalid()
    return Object.freeze({ kind: this.#header.kind, bytes: this.#header.bytes, sha256: this.#header.sha256 })
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (!openedProvenanceFields.has(this) || this.#header === undefined) invalid()
    offset = number(offset, this.#header.bytes)
    length = number(length, Math.min(16384, this.#header.bytes - offset))
    let result: Uint8Array | undefined
    try {
      return await this.#writer(async (trx, scope, header) => {
        const bytes = new Uint8Array(length)
        result = bytes
        try {
          let written = 0
          while (written < length) {
            const starts: Array<{ byteOffset: unknown }> = await trx(snapshotJournalFieldCacheNames.chunks)
              .where('versionId', header.versionId)
              .where('byteOffset', '<=', offset + written)
              .select('byteOffset')
              .orderBy('byteOffset', 'desc')
              .limit(1)
            if (starts.length !== 1) invalid()
            const start = number(starts[0].byteOffset, header.bytes),
              chunk = await readSnapshotJournalFieldCacheChunk(trx, scope, header, start)
            try {
              const local = offset + written - start,
                count = Math.min(length - written, chunk.bytes.length - local)
              if (count < 1 || local < 0) invalid()
              bytes.set(chunk.bytes.subarray(local, local + count), written)
              written += count
            } finally {
              chunk.bytes.fill(0)
            }
          }
          return bytes
        } catch (cause) {
          bytes.fill(0)
          throw cause
        }
      })
    } catch (cause) {
      result?.fill(0)
      throw cause
    }
  }
  close(): void {
    this.#closed = true
    openedProvenanceFields.delete(this)
    this.#charge.close()
  }
}
