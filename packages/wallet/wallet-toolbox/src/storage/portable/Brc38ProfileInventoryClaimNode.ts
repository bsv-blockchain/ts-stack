import type { Knex } from 'knex'
import { join, resolve } from 'node:path'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import type { Brc38PublishedProfileNode, Brc38ProfileInventoryBinding } from './Brc38PublishedProfileNode'

export interface Brc38ProfileCreationGrant {
  readonly directory: string
  readonly bindingSha256: string
  readonly inventory: Brc38ProfileInventoryBinding
}
interface ActualGrant {
  readonly trx: Knex.Transaction
  readonly grant: Brc38ProfileCreationGrant
}
const creations = new WeakMap<Brc38ProfileCreationGrant, ActualGrant>()
const retirements = new WeakMap<Brc38ProfileCreationGrant, ActualGrant>()
const withdrawals = new WeakMap<Brc38ProfileCreationGrant, ActualGrant>()
const ready = new WeakMap<Brc38PublishedProfileNode, Brc38ProfileInventoryBinding>()

function nativeCatalog(trx: Knex.Transaction, directory: string): void {
  requireBrc38ImportSqliteTransaction(trx)
  if (trx.isCompleted()) throw new Error('Profile inventory writer has completed')
  const connection = trx.client.config.connection
  if (
    typeof connection !== 'object' ||
    connection === null ||
    !('filename' in connection) ||
    typeof connection.filename !== 'string' ||
    resolve(connection.filename) !== resolve(join(directory, 'profile-inventory.sqlite'))
  )
    throw new Error('Profile inventory requires the actual native catalog transaction')
}
async function registered(
  trx: Knex.Transaction,
  root: string,
  inventory: Brc38ProfileInventoryBinding,
  bindingSha256: string,
  state: 'reserved' | 'published' | 'retiring' | 'withdrawing'
): Promise<void> {
  nativeCatalog(trx, root)
  if (state !== 'published') await trx('profile_inventory_capacity').where({ slot: 1 }).update({ slot: 1 })
  const capacity = await trx('profile_inventory_capacity')
    .where({ slot: 1, rootId: inventory.rootId, policySha256: inventory.policySha256 })
    .select('slot')
    .limit(2)
  const profiles = await trx('profile_inventory')
    .where({ id: inventory.profileId, bindingSha256, state })
    .select('id')
    .limit(2)
  if (capacity.length !== 1 || profiles.length !== 1)
    throw new Error('Actual profile inventory scope or durable state differs')
}
/** Only an actual uncommitted inventory writer with the matching reservation
 * can grant filesystem creation. This is not a caller supplied boolean lease. */
export async function createBrc38ProfileCreationGrant(
  trx: Knex.Transaction,
  root: string,
  inventory: Brc38ProfileInventoryBinding,
  bindingSha256: string
): Promise<Brc38ProfileCreationGrant> {
  await registered(trx, root, inventory, bindingSha256, 'reserved')
  const grant = Object.freeze({
    directory: join(root, inventory.profileId),
    bindingSha256,
    inventory: Object.freeze({ ...inventory })
  })
  creations.set(grant, { trx, grant })
  return grant
}
export async function assertBrc38ProfileCreationGrant(grant: Brc38ProfileCreationGrant): Promise<void> {
  const actual = creations.get(grant)
  if (actual === undefined) throw new Error('An actual profile inventory creation grant is required')
  await registered(actual.trx, join(grant.directory, '..'), grant.inventory, grant.bindingSha256, 'reserved')
}
/** The independent read transaction must physically commit before activation
 * authority is returned. A row observed inside a rolled-back writer grants nothing. */
export async function registerBrc38InventoryPublishedProfile(
  db: Knex,
  root: string,
  profile: Brc38PublishedProfileNode,
  inventory: Brc38ProfileInventoryBinding,
  bindingSha256: string
): Promise<void> {
  await db.transaction(async trx => {
    await registered(trx, root, inventory, bindingSha256, 'published')
    await profile.assertInventoryBinding(inventory, bindingSha256)
  })
  ready.set(profile, Object.freeze({ ...inventory }))
}
export async function createBrc38ProfileRetirementGrant(
  trx: Knex.Transaction,
  root: string,
  inventory: Brc38ProfileInventoryBinding,
  bindingSha256: string
): Promise<Brc38ProfileCreationGrant> {
  await registered(trx, root, inventory, bindingSha256, 'retiring')
  const grant = Object.freeze({
    directory: join(root, inventory.profileId),
    bindingSha256,
    inventory: Object.freeze({ ...inventory })
  })
  retirements.set(grant, { trx, grant })
  return grant
}
export async function assertBrc38ProfileRetirementGrant(grant: Brc38ProfileCreationGrant): Promise<void> {
  const actual = retirements.get(grant)
  if (actual === undefined) throw new Error('An actual profile inventory retirement grant is required')
  await registered(actual.trx, join(grant.directory, '..'), grant.inventory, grant.bindingSha256, 'retiring')
}
export async function createBrc38ProfileWithdrawalGrant(
  trx: Knex.Transaction,
  root: string,
  inventory: Brc38ProfileInventoryBinding,
  bindingSha256: string
): Promise<Brc38ProfileCreationGrant> {
  await registered(trx, root, inventory, bindingSha256, 'withdrawing')
  const grant = Object.freeze({
    directory: join(root, inventory.profileId),
    bindingSha256,
    inventory: Object.freeze({ ...inventory })
  })
  withdrawals.set(grant, { trx, grant })
  return grant
}
/** The actual durable inventory withdrawal, not an incomplete-retirement grant,
 * is required before a READY copy can be physically removed. */
export async function assertBrc38ProfileWithdrawalGrant(grant: Brc38ProfileCreationGrant): Promise<void> {
  const actual = withdrawals.get(grant)
  if (actual === undefined) throw new Error('An actual inactive composed withdrawal grant is required')
  await registered(actual.trx, join(grant.directory, '..'), grant.inventory, grant.bindingSha256, 'withdrawing')
}
export function assertBrc38InventoryActivation(
  profile: Brc38PublishedProfileNode,
  inventory: Brc38ProfileInventoryBinding | undefined
): void {
  if (inventory !== undefined && JSON.stringify(ready.get(profile)) !== JSON.stringify(inventory))
    throw new Error('Managed profile requires its actual durable inventory acknowledgement')
}
