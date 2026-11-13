import { copyBrc38ComposedProfileReceipt, type Brc38ComposedProfileReceipt } from './Brc38ComposedProfileReceiptNode'
import { readBrc38NativeCatalog } from './Brc38NativeCatalogNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'
import { brc38StagingBinding, type Brc38StagingBinding } from './Brc38StagingBinding'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import {
  validBrc38ProfilePhysicalIdentity,
  type Brc38ProfilePhysicalIdentity
} from './Brc38ProfilePhysicalIdentityNode'
import type { Brc38ProfileInventoryBinding } from './Brc38PublishedProfileNode'

// Internal shared original receipt validation. This grants no native process,
// inventory, physical allocation or WAL-promotion authority by itself.
export type State = 'RECEIVING' | 'READY' | 'ACTIVATING' | 'ACTIVE'
export interface FixedProfile {
  protocol: 'brc38-published-profile/v1' | 'brc38-published-profile/v2' | 'brc38-published-profile/v3'
  composition?: Readonly<Brc38ComposedProfileReceipt>
  physicalIdentity?: Brc38ProfilePhysicalIdentity
  inventory?: Brc38ProfileInventoryBinding
  binding: Brc38StagingBinding
  bindingSha256: string
  limits: KnexBrc38StagingLimits
  admission: Brc38ImportJournalAdmission
}
export interface Row {
  state: State
  fixedJson: string
  fixedSha256: string
  copySha256: string | null
  copyBytes: number | null
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
export function pages(limits: KnexBrc38StagingLimits): number {
  return Math.min(2147483646, Math.floor((limits.maximumPhysicalBytes - 131072) / (3 * 4096)))
}
export async function readRow(db: Knex): Promise<Row> {
  return (await readBrc38NativeCatalog(db)) ?? (await readOriginalProfileRow(db))
}
/** Original bounded stock receipt reader; no native session or activation authority. */
export async function readOriginalProfileRow(db: Knex): Promise<Row> {
  return await readProfileReceipt(db, 'profile')
}
export async function readForwardOriginalProfileRow(db: Knex): Promise<Row> {
  return await readProfileReceipt(db, 'profile_original')
}
async function readProfileReceipt(db: Knex, table: 'profile' | 'profile_original'): Promise<Row> {
  const rows: Row[] = await db(table)
    .where({ slot: 1 })
    .select(
      db.raw('CASE WHEN length(CAST(state AS BLOB)) <= 16 THEN state ELSE NULL END AS state'),
      db.raw('CASE WHEN length(CAST(copySha256 AS BLOB)) = 64 THEN copySha256 ELSE NULL END AS copySha256'),
      db.raw("CASE WHEN typeof(copyBytes) = 'integer' THEN copyBytes ELSE NULL END AS copyBytes"),
      db.raw('CASE WHEN length(CAST(fixedJson AS BLOB)) <= 8192 THEN fixedJson ELSE NULL END AS fixedJson'),
      db.raw('CASE WHEN length(CAST(fixedSha256 AS BLOB)) = 64 THEN fixedSha256 ELSE NULL END AS fixedSha256')
    )
    .limit(2)
  const row = rows[0]
  if (
    rows.length !== 1 ||
    typeof row?.fixedJson !== 'string' ||
    hash(row.fixedJson) !== row.fixedSha256 ||
    !['RECEIVING', 'READY', 'ACTIVATING', 'ACTIVE'].includes(row.state)
  )
    throw new Error('Published profile catalog differs')
  if (
    row.state !== 'RECEIVING' &&
    (typeof row.copySha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.copySha256) ||
      !Number.isSafeInteger(row.copyBytes) ||
      row.copyBytes! < 4096)
  )
    throw new Error('Published profile copy receipt differs')
  return row
}
export function fixedProfile(row: Row, expectedBindingSha256: string): FixedProfile {
  const fixed = JSON.parse(row.fixedJson) as FixedProfile
  if (
    !['brc38-published-profile/v1', 'brc38-published-profile/v2', 'brc38-published-profile/v3'].includes(
      fixed.protocol
    ) ||
    fixed.bindingSha256 !== expectedBindingSha256 ||
    brc38StagingBinding(fixed.binding, fixed.limits).digest !== expectedBindingSha256 ||
    fixed.admission.scope.bindingSha256 !== expectedBindingSha256 ||
    fixed.admission.expiresAt !== fixed.limits.expiresAt ||
    fixed.admission.originalLimitsJson !== brc38StagingBinding(fixed.binding, fixed.limits).limitsJson ||
    !Number.isSafeInteger(fixed.limits.maximumPhysicalBytes) ||
    fixed.limits.maximumPhysicalBytes < 1048576
  )
    throw new Error('Published profile original binding or policy differs')
  if (
    fixed.protocol !== 'brc38-published-profile/v1' &&
    (fixed.physicalIdentity !== undefined || row.state !== 'RECEIVING') &&
    !validBrc38ProfilePhysicalIdentity(fixed.physicalIdentity, row.state !== 'RECEIVING')
  )
    throw new Error('Published profile durable physical binding is incomplete')
  if (fixed.protocol === 'brc38-published-profile/v3') {
    const keys = [
      'protocol',
      'inventory',
      'binding',
      'bindingSha256',
      'limits',
      'admission',
      'physicalIdentity',
      'composition'
    ]
    if (
      row.state === 'RECEIVING' ||
      fixed.inventory === undefined ||
      fixed.composition === undefined ||
      Object.keys(fixed).length !== keys.length ||
      keys.some(key => !Object.hasOwn(fixed, key))
    )
      throw new Error('Composed publication requires complete original lineage and physical receipt')
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    if (
      Object.keys(fixed.inventory).length !== 3 ||
      !uuid.test(fixed.inventory.rootId) ||
      !uuid.test(fixed.inventory.profileId) ||
      !/^[0-9a-f]{64}$/.test(fixed.inventory.policySha256)
    )
      throw new Error('Composed publication target inventory differs')
    const composition = copyBrc38ComposedProfileReceipt(fixed.composition)
    if (
      JSON.stringify(composition) !== JSON.stringify(fixed.composition) ||
      composition.source.userId !== fixed.admission.scope.userId ||
      composition.source.activeStorage !== fixed.binding.targetStorageIdentityKey ||
      (composition.source.inventory.rootId === fixed.inventory.rootId &&
        composition.source.inventory.profileId === fixed.inventory.profileId)
    )
      throw new Error('Composed publication original source or primary differs')
    fixed.composition = composition
  } else if (fixed.composition !== undefined)
    throw new Error('Composed lineage requires its explicit published-profile protocol')
  return fixed
}
export function validPrimary(state: State, primary: string, selected: string, fixed?: FixedProfile): boolean {
  if (fixed?.protocol === 'brc38-published-profile/v3')
    return state !== 'RECEIVING' && fixed.composition?.source.activeStorage === selected && primary === selected
  if (state === 'READY') return primary === ''
  if (state === 'ACTIVE') return primary === selected
  return primary === '' || primary === selected
}
