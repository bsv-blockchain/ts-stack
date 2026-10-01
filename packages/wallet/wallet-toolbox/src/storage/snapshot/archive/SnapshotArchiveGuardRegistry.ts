import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotArchiveLimits } from './SnapshotArchive'
import type { SnapshotArchiveRequestOwner } from './SnapshotArchiveRequest'
import { lockSnapshotArchiveCapacity, snapshotArchiveDatabaseNow } from './SnapshotArchiveSql'

export interface SnapshotArchiveOwnerGuard {
  owner: SnapshotArchiveRequestOwner
  slot: number
  bindingJson: string | null
}

interface RequestState {
  state: string
  expiresAt: number | string
  released: number | boolean
}

const terminal = ['closed', 'failed', 'expired', 'resource-limited']

function unavailable(): never {
  throw new WERR_INVALID_OPERATION('Snapshot archive source guard is unavailable')
}

async function ownerGuard(k: Knex, owner: SnapshotArchiveRequestOwner): Promise<SnapshotArchiveOwnerGuard | undefined> {
  const row: { slot: number } | undefined = await k('snapshot_archive_owners')
    .where({ ...owner, guardVersion: 1 })
    .first('slot')
  if (row === undefined) return undefined
  if (!Number.isSafeInteger(row.slot) || row.slot < 0 || row.slot >= snapshotArchiveLimits.archives) unavailable()
  const slot: { bindingJson: string | null } | undefined = await k('snapshot_archive_owner_slots')
    .where({ slot: row.slot })
    .first('bindingJson')
  if (slot === undefined || (slot.bindingJson !== null && typeof slot.bindingJson !== 'string')) unavailable()
  return { owner: { ...owner }, slot: row.slot, bindingJson: slot.bindingJson }
}

/** The source calls this only after acquiring the backend guard, before any wallet-data read. */
export async function assertSnapshotArchiveGuardOwner(k: Knex, expected: SnapshotArchiveOwnerGuard): Promise<void> {
  const actual = await ownerGuard(k, expected.owner)
  const request: RequestState | undefined = await k('snapshot_archive_requests').where(expected.owner).first()
  if (
    actual === undefined ||
    actual.slot !== expected.slot ||
    actual.bindingJson !== expected.bindingJson ||
    request === undefined ||
    request.released ||
    !['claimed', 'capturing'].includes(request.state) ||
    Number(request.expiresAt) <= (await snapshotArchiveDatabaseNow(k))
  )
    unavailable()
}

/** Leave the main writer lock before filesystem or backend preparation. */
export async function readSnapshotArchiveOwnerGuard(
  knex: Knex,
  input: SnapshotArchiveRequestOwner
): Promise<SnapshotArchiveOwnerGuard> {
  const owner = { ...input }
  return await knex.transaction(async trx => {
    await lockSnapshotArchiveCapacity(trx)
    const context = await ownerGuard(trx, owner)
    if (context === undefined) unavailable()
    await assertSnapshotArchiveGuardOwner(trx, context)
    return context
  })
}

/** Fixed slot bindings survive owner release; delayed claimants cannot select a new guard. */
export async function bindSnapshotArchiveOwnerGuard(
  knex: Knex,
  context: SnapshotArchiveOwnerGuard,
  bindingJson: string,
  verifyBackend: (trx: Knex) => Promise<void>
): Promise<SnapshotArchiveOwnerGuard> {
  return await knex.transaction(async trx => {
    await lockSnapshotArchiveCapacity(trx)
    await verifyBackend(trx)
    const current = await ownerGuard(trx, context.owner)
    if (current === undefined || current.slot !== context.slot) unavailable()
    await assertSnapshotArchiveGuardOwner(trx, current)
    if (current.bindingJson !== null && current.bindingJson !== bindingJson) unavailable()
    await trx('snapshot_archive_owner_slots').where({ slot: current.slot }).update({ bindingJson })
    return { ...current, bindingJson }
  })
}

/** At most eight owners; older unguarded candidates remain reserved for explicit cleanup. */
export async function expiredSnapshotArchiveOwnerGuards(knex: Knex): Promise<SnapshotArchiveOwnerGuard[]> {
  const now = await snapshotArchiveDatabaseNow(knex)
  const rows: Array<SnapshotArchiveRequestOwner & { slot: number; bindingJson: string | null }> = await knex(
    'snapshot_archive_owners as owner'
  )
    .join('snapshot_archive_requests as request', function () {
      this.on('owner.identityKey', 'request.identityKey')
        .andOn('owner.requestId', 'request.requestId')
        .andOn('owner.claimToken', 'request.claimToken')
    })
    .join('snapshot_archive_owner_slots as slot', 'slot.slot', 'owner.slot')
    .where('owner.guardVersion', 1)
    .where(query => {
      void query.where('request.expiresAt', '<=', now).orWhereIn('request.state', terminal)
    })
    .select('owner.identityKey', 'owner.requestId', 'owner.claimToken', 'owner.slot', 'slot.bindingJson')
    .limit(snapshotArchiveLimits.archives)
  return rows.map(({ slot, bindingJson, ...owner }) => ({ owner, slot, bindingJson }))
}

/** Caller holds the backend guard, or proves the binding is still null under this lock. */
export async function fenceSnapshotArchiveOwnerGuard(
  k: Knex,
  context: SnapshotArchiveOwnerGuard,
  acknowledge = false
): Promise<boolean> {
  await lockSnapshotArchiveCapacity(k)
  const actual = await ownerGuard(k, context.owner)
  if (actual === undefined || actual.slot !== context.slot || actual.bindingJson !== context.bindingJson) return false
  const request: RequestState | undefined = await k('snapshot_archive_requests').where(context.owner).first()
  if (request === undefined || request.released) unavailable()
  const expired = Number(request.expiresAt) <= (await snapshotArchiveDatabaseNow(k))
  if (!expired && !terminal.includes(request.state)) return false
  if (!terminal.includes(request.state)) {
    await k('snapshot_archive_requests').where(context.owner).update({ state: 'expired' })
  }
  if (acknowledge)
    await k('snapshot_archive_owners')
      .where({ ...context.owner, slot: context.slot })
      .delete()
  return true
}
