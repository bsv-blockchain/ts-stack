import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { brc38PrivateLocalCandidateStateTable as candidate } from './Brc38PrivateLocalCandidateJournalNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { readBrc38PrivateLocalCandidateJournal } from './Brc38PrivateLocalCandidateJournalNode'
import { brc38PrivateMergeRecoveryTable, readBrc38PrivateMergeRecovery } from './Brc38PrivateMergeRecoverySchemaNode'
import {
  installBrc38PrivateMergeTargets,
  prepareBrc38PrivateMergeTargetBudget,
  brc38PrivateMergeTargetCharge
} from './Brc38PrivateMergeTargetsNode'
import {
  installBrc38PrivateMergePages,
  prepareBrc38PrivateMergePageBudget,
  brc38PrivateMergePageCharge
} from './Brc38PrivateMergePagesNode'

const table = 'brc38_private_merge_program'
const definitions = Object.freeze([
  `CREATE TABLE ${table}(slot INTEGER PRIMARY KEY CHECK(slot=1),bindingSha256 TEXT NOT NULL CHECK(length(bindingSha256)=64),sourceSha256 TEXT NOT NULL CHECK(length(sourceSha256)=64),policyJson TEXT NOT NULL CHECK(typeof(policyJson)='text' AND length(CAST(policyJson AS BLOB)) BETWEEN 1 AND 4096),maximumMappedIds INTEGER NOT NULL CHECK(typeof(maximumMappedIds)='integer' AND maximumMappedIds BETWEEN 0 AND 1000000000),maximumJournalLogicalBytes INTEGER NOT NULL CHECK(typeof(maximumJournalLogicalBytes)='integer' AND maximumJournalLogicalBytes BETWEEN 4096 AND 9007199254740991))`,
  `CREATE TRIGGER ${table}_insert BEFORE INSERT ON ${table} WHEN NOT EXISTS(SELECT 1 FROM ${candidate} WHERE slot=1 AND bindingSha256=NEW.bindingSha256 AND sourceSha256=NEW.sourceSha256) BEGIN SELECT RAISE(ABORT,'Private merge original program differs'); END`,
  `CREATE TRIGGER ${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Private merge program is immutable'); END`,
  `CREATE TRIGGER ${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Private merge program requires candidate retirement'); END`
])
function invalid(): never {
  throw new Error('Private merge original program or aggregate journal budget differs')
}
function actual(k: Knex.Transaction, writer = false): void {
  if (
    !k.isTransaction ||
    k.isCompleted() ||
    !(writer ? isBrc38OwnedPrivateNativeWriter(k) : isBrc38OwnedPrivateNativeSqlite(k))
  )
    invalid()
}
export interface Brc38PrivateMergeProgram {
  readonly bindingSha256: string
  readonly sourceSha256: string
  readonly policyJson: string
  readonly maximumMappedIds: number
  readonly maximumJournalLogicalBytes: number
}
export async function hasBrc38PrivateMergeProgram(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const total = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [table.length, table])
    .count({ count: '*' })
    .first()) as { count: number } | undefined
  if (total?.count === 0) return false
  if (total?.count !== definitions.length) invalid()
  for (const sql of definitions) {
    const [, type, name] = /^CREATE (TABLE|TRIGGER) (\w+)/.exec(sql)!,
      row = (await k('sqlite_schema')
        .where({ name, type: type.toLowerCase() })
        .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
        .count({ count: '*' })
        .first()) as { count: number } | undefined
    if (row?.count !== 1) invalid()
  }
  const totalObjects = (await k('sqlite_schema').where({ tbl_name: table }).count({ count: '*' }).first()) as
    { count: number } | undefined
  if (totalObjects?.count !== definitions.length) invalid()
  return true
}
export async function readBrc38PrivateMergeProgram(k: Knex.Transaction): Promise<Brc38PrivateMergeProgram | undefined> {
  if (!(await hasBrc38PrivateMergeProgram(k))) return undefined
  const rows = (await k(table)
    .where({ slot: 1 })
    .select(
      'bindingSha256',
      'sourceSha256',
      'maximumMappedIds',
      'maximumJournalLogicalBytes',
      k.raw('CASE WHEN length(CAST(policyJson AS BLOB)) BETWEEN 1 AND 4096 THEN policyJson END AS policyJson')
    )
    .limit(2)) as Brc38PrivateMergeProgram[]
  if (rows.length !== 1 || typeof rows[0].policyJson !== 'string') invalid()
  const context = await k(candidate)
    .where({ slot: 1, bindingSha256: rows[0].bindingSha256, sourceSha256: rows[0].sourceSha256 })
    .select('slot')
    .limit(2)
  if (context.length !== 1) invalid()
  actual(k)
  return rows[0]
}
export async function prepareBrc38PrivateMergeProgram(
  k: Knex.Transaction,
  selected: Brc38PrivateMergeProgram
): Promise<void> {
  actual(k, true)
  const input = Object.freeze({ ...selected })
  if (
    !/^[0-9a-f]{64}$/.test(input.bindingSha256) ||
    !/^[0-9a-f]{64}$/.test(input.sourceSha256) ||
    typeof input.policyJson !== 'string' ||
    Buffer.byteLength(input.policyJson) < 1 ||
    Buffer.byteLength(input.policyJson) > 4096 ||
    !Number.isSafeInteger(input.maximumMappedIds) ||
    input.maximumMappedIds < 0 ||
    input.maximumMappedIds > 1000000000 ||
    !Number.isSafeInteger(input.maximumJournalLogicalBytes) ||
    input.maximumJournalLogicalBytes < 4096
  )
    invalid()
  if (!(await hasBrc38PrivateMergeProgram(k))) for (const sql of definitions) await k.raw(sql)
  const slots = await k(table).where({ slot: 1 }).select('slot').limit(2)
  if (slots.length === 0) await k(table).insert({ slot: 1, ...input })
  else if (slots.length !== 1) invalid()
  const current = await readBrc38PrivateMergeProgram(k)
  if (current === undefined) invalid()
  if (Object.entries(input).some(([key, value]) => current[key as keyof Brc38PrivateMergeProgram] !== value)) invalid()
  await installBrc38PrivateMergeTargets(k)
  await installBrc38PrivateMergePages(k)
}
/** Apply after actual journal insertion or page effects and before that same
 * writer commits. At most four admitted episodes share the original caps;
 * replay and rebuild never obtain fresh mapping or journal allowances. */
export async function assertBrc38PrivateMergeProgramBudget(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission
): Promise<void> {
  // Ordinary restore/legacy writers retain their original contract. Only the
  // actual private native candidate can have this optional composition program.
  if (!isBrc38OwnedPrivateNativeSqlite(k)) return
  const program = await readBrc38PrivateMergeProgram(k)
  if (program === undefined) return
  actual(k)
  if (
    program.bindingSha256 !== admission.scope.bindingSha256 ||
    program.maximumMappedIds !== admission.maximumMappedIds ||
    program.maximumJournalLogicalBytes !== admission.maximumJournalLogicalBytes
  )
    invalid()
  const journals = (await k('brc38_import_journal')
    .select('importId', 'bindingSha256', 'mappedIds', 'maximumMappedIds', 'cleanupAllowed')
    .orderBy('importId')
    .limit(5)) as Array<{
    importId: string
    bindingSha256: string
    mappedIds: number
    maximumMappedIds: number
    cleanupAllowed: number
  }>
  let mapped = 0
  if (journals.length < 1 || journals.length > 4 || !journals.some(row => row.importId === admission.scope.importId))
    invalid()
  for (const row of journals) {
    if (
      row.bindingSha256 !== program.bindingSha256 ||
      row.cleanupAllowed !== 0 ||
      row.maximumMappedIds !== program.maximumMappedIds ||
      !Number.isSafeInteger(row.mappedIds) ||
      row.mappedIds < 0
    )
      invalid()
    mapped += row.mappedIds
  }
  const bytes =
    journals.length * 4096 +
    mapped * 512 +
    (await brc38PrivateMergeTargetCharge(k)) +
    (await brc38PrivateMergePageCharge(k))
  if (
    !Number.isSafeInteger(mapped) ||
    !Number.isSafeInteger(bytes) ||
    mapped > program.maximumMappedIds ||
    bytes > program.maximumJournalLogicalBytes
  )
    invalid()
  const limits = JSON.parse(admission.originalLimitsJson) as number[],
    originalBudgets = (await k('brc38_import_structured_original_budget')
      .select(
        'importId',
        'bindingSha256',
        'archiveSha256',
        'userId',
        'maximumRows',
        'maximumLogicalBytes',
        'rows',
        'logicalBytes'
      )
      .orderBy('importId')
      .limit(5)) as Array<{
      importId: string
      bindingSha256: string
      archiveSha256: string
      userId: number
      maximumRows: number
      maximumLogicalBytes: number
      rows: number
      logicalBytes: number
    }>
  let originalBytes = 0
  if (originalBudgets.length > 4 || !Number.isSafeInteger(limits[1]) || limits[1] < 1) invalid()
  for (const row of originalBudgets) {
    if (
      !journals.some(journal => journal.importId === row.importId) ||
      row.bindingSha256 !== admission.scope.bindingSha256 ||
      row.archiveSha256 !== admission.scope.archiveSha256 ||
      row.userId !== admission.scope.userId ||
      row.maximumRows !== admission.totalRows ||
      row.maximumLogicalBytes !== limits[1] ||
      !Number.isSafeInteger(row.rows) ||
      row.rows < 0 ||
      row.rows > row.maximumRows ||
      !Number.isSafeInteger(row.logicalBytes) ||
      row.logicalBytes < 0 ||
      row.logicalBytes > row.maximumLogicalBytes
    )
      invalid()
    originalBytes += row.logicalBytes
  }
  if (!Number.isSafeInteger(originalBytes) || originalBytes > limits[1]) invalid()
  actual(k)
}

/** The journal and active episode bind in the SAME private writer. A crash
 * after preparation cannot leave an orphan prepared journal that a fresh
 * preview would supersede. Actual schema/program/context checks are required. */
export async function bindBrc38PrivateMergeProgramJournal(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission
): Promise<void> {
  if (!isBrc38OwnedPrivateNativeSqlite(k)) return
  const program = await readBrc38PrivateMergeProgram(k)
  if (program === undefined) return
  actual(k, true)
  const current = await readBrc38PrivateLocalCandidateJournal(k),
    recovery = await readBrc38PrivateMergeRecovery(k),
    receipt = await readBrc38ImportJournal(k, admission)
  if (
    current.phase !== 'RECOVERY' ||
    recovery === undefined ||
    recovery.episode !== current.rebuilds ||
    recovery.bindingSha256 !== program.bindingSha256 ||
    recovery.sourceSha256 !== program.sourceSha256 ||
    recovery.sourceEpoch !== current.epoch ||
    program.bindingSha256 !== admission.scope.bindingSha256 ||
    receipt.state === 'EXPIRED' ||
    BigInt(recovery.sourceRevision) > BigInt(current.caughtUpRevision)
  )
    invalid()
  if (recovery.phase === 'IMPORT') {
    if (recovery.activeImportId !== admission.scope.importId) invalid()
    await prepareBrc38PrivateMergeTargetBudget(k, admission)
    await prepareBrc38PrivateMergePageBudget(k, admission)
    return
  }
  if (
    receipt.nextRow !== 0 ||
    (await k(brc38PrivateMergeRecoveryTable)
      .where({ slot: 1, phase: 'BASELINE', episode: current.rebuilds })
      .update({
        phase: 'IMPORT',
        activeImportId: admission.scope.importId,
        sourceRevision: k.raw('CAST(? AS INTEGER)', [current.caughtUpRevision])
      })) !== 1
  )
    invalid()
  const post = await readBrc38PrivateMergeRecovery(k)
  if (post?.phase !== 'IMPORT' || post.activeImportId !== admission.scope.importId) invalid()
  await prepareBrc38PrivateMergeTargetBudget(k, admission)
  await prepareBrc38PrivateMergePageBudget(k, admission)
  actual(k, true)
}
