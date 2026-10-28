import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { admissionCopy } from './Brc38ImportJournalCore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { requireBrc38StructuredProjectionRead } from './Brc38PublishedStructuredSourceNode'
import {
  brc38StructuredRestoreResourcesFromData,
  type Brc38PrivateStructuredRestoreResources,
  type Brc38StructuredRestoreResourceData
} from './Brc38StructuredRestoreResourcesNode'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import {
  inspectBrc38ReadyPublishedStructuredNativeInventory,
  inspectBrc38PublishedCopyStructuredInventory
} from './Brc38StructuredNativeInventoryNode'

function invalid(): never {
  throw new Error('Published structured receiver admission or resource data differs')
}
/** Current SQL metadata is bounded comparison DATA. Every caller still holds
 * its actual read actor, physical/kernel/catalog/source/layout checks; this
 * neither creates a scratch reservation nor revives the private import. */
export async function readBrc38StructuredRestoreResources(
  k: Knex.Transaction,
  selected: Readonly<Brc38ImportJournalAdmission>
): Promise<Readonly<Brc38PrivateStructuredRestoreResources & { maximumWorkingAllocationBytes: number }> | undefined> {
  const admission = admissionCopy(selected)
  requireBrc38StructuredProjectionRead(k)
  const rows = (await k('private_native_restore')
    .where({ slot: 1 })
    .select(
      k.raw(
        "CASE WHEN typeof(protocol)='text' AND length(CAST(protocol AS BLOB))<=64 THEN protocol ELSE NULL END AS protocol"
      ),
      k.raw(
        "CASE WHEN typeof(bindingSha256)='text' AND length(CAST(bindingSha256 AS BLOB))=64 THEN bindingSha256 ELSE NULL END AS bindingSha256"
      ),
      ...['admissionJson', 'policyJson'].map(field =>
        k.raw(
          "CASE WHEN typeof(??)='text' AND length(CAST(?? AS BLOB)) BETWEEN 1 AND 4096 THEN ?? ELSE NULL END AS ??",
          [field, field, field, field]
        )
      ),
      k.raw(
        "CASE WHEN typeof(admissionSha256)='text' AND length(CAST(admissionSha256 AS BLOB))=64 THEN admissionSha256 ELSE NULL END AS admissionSha256"
      )
    )
    .limit(2)) as Array<{
    protocol: string | null
    bindingSha256: string | null
    admissionJson: string | null
    policyJson: string | null
    admissionSha256: string | null
  }>
  if (rows.length !== 1) invalid()
  const row = rows[0]
  if (row.protocol === 'brc38-private-native-restore/v1' || row.protocol === 'brc38-private-native-restore/v4')
    return undefined
  if (
    row.protocol !== 'brc38-private-native-restore/v5' ||
    row.bindingSha256 !== admission.scope.bindingSha256 ||
    row.admissionJson !== JSON.stringify(admission) ||
    typeof row.policyJson !== 'string' ||
    createHash('sha256').update(row.admissionJson).digest('hex') !== row.admissionSha256
  )
    invalid()
  const limits = JSON.parse(admission.originalLimitsJson) as number[],
    original = JSON.parse(row.policyJson) as { structuredResources: Brc38StructuredRestoreResourceData },
    resources = brc38StructuredRestoreResourcesFromData(
      {
        maximumRows: limits[0],
        maximumLogicalBytes: limits[1],
        maximumPhysicalBytes: limits[2],
        maximumRowBytes: limits[3],
        maximumRowAllocationBytes: limits[4],
        expiresAt: limits[5]
      },
      original.structuredResources,
      admission.maximumStepBytes
    )
  requireBrc38StructuredProjectionRead(k)
  return resources
}

/** A fresh finite READY/copy inspection. Runtime routing is not an actor
 * grant. It regenerates the full original inventory, then re-reads immutable
 * receiver resource/admission DATA before returning its dispatch result. */
export async function inspectBrc38PublishedStructuredRestoreInventory(
  k: Knex.Transaction,
  selected: Readonly<Brc38ImportJournalAdmission>,
  runtime: 'published-native' | 'published-copy',
  inspectionExpiresAt: number,
  signal?: AbortSignal
): Promise<boolean> {
  const admission = admissionCopy(selected),
    expiresAt = inspectionExpiresAt,
    started = performance.now(),
    lifetime = expiresAt - Date.now()
  signal?.throwIfAborted()
  requireBrc38StructuredProjectionRead(k)
  if (
    !['published-native', 'published-copy'].includes(runtime) ||
    !Number.isSafeInteger(expiresAt) ||
    lifetime < 1 ||
    lifetime > 3600000
  )
    invalid()
  const original = await readBrc38StructuredRestoreResources(k, admission)
  if (original === undefined) return false
  const working = new Brc38WorkingAllocation(original.maximumWorkingAllocationBytes)
  const policy = Object.freeze({
    sourcePolicy: Object.freeze({ ...original.sourcePolicy, workingAllocation: working, signal }),
    projectionPolicy: Object.freeze({ ...original.projectionPolicy, workingAllocation: working, expiresAt, signal }),
    maximumCombinedTemporaryBytes: original.maximumCombinedTemporaryBytes,
    inspectionExpiresAt: expiresAt
  })
  if (runtime === 'published-native')
    await inspectBrc38ReadyPublishedStructuredNativeInventory(k, admission, policy, signal)
  else await inspectBrc38PublishedCopyStructuredInventory(k, admission, policy, signal)
  signal?.throwIfAborted()
  requireBrc38StructuredProjectionRead(k)
  if (
    Date.now() >= expiresAt ||
    performance.now() - started >= lifetime ||
    JSON.stringify(await readBrc38StructuredRestoreResources(k, admission)) !== JSON.stringify(original)
  )
    invalid()
  return true
}
