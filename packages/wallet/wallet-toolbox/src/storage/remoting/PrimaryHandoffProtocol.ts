import type { PrimaryHandoffStatus, PrimaryHandoffSource, PrimaryHandoffPlan } from '../PrimaryHandoffControl'
import { canonicalPrimaryHandoffPlan, primaryHandoffIdentity, primaryHandoffOperation } from '../PrimaryHandoffPlan'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import { snapshotJournalDataRecord } from '../snapshot/journal/SnapshotJournalReceiptData'
export const primaryHandoffRequestBytes = 8192
export const primaryHandoffResponseBytes = 8192
export const primaryHandoffCapabilities = Object.freeze({
  version: 1 as const,
  protocol: 'wallet-primary-handoff/1' as const,
  maximumSources: 8 as const
})
export const primaryHandoffMethods = [
  'primaryHandoffStatus',
  'preparePrimaryHandoffSource',
  'preparePrimaryHandoffTarget',
  'retirePrimaryHandoffSource',
  'activatePrimaryHandoffTarget',
  'completePrimaryHandoffSource',
  'completePrimaryHandoffTarget',
  'followPrimaryHandoffTarget',
  'cancelPrimaryHandoff'
] as const
export type PrimaryHandoffMethod = (typeof primaryHandoffMethods)[number]
export function isPrimaryHandoffMethod(value: unknown): value is PrimaryHandoffMethod {
  return typeof value === 'string' && (primaryHandoffMethods as readonly string[]).includes(value)
}
export function validatePrimaryHandoffCapabilities(value: unknown): void {
  const row = snapshotJournalDataRecord(value, ['version', 'protocol', 'maximumSources'])
  if (Object.entries(primaryHandoffCapabilities).some(([key, expected]) => row[key] !== expected))
    throw new TypeError('Invalid primary handoff capabilities')
}
export function parsePrimaryHandoffSource(value: unknown): PrimaryHandoffSource {
  const row = snapshotJournalDataRecord(value, ['storageIdentityKey', 'epoch'])
  return {
    storageIdentityKey: primaryHandoffIdentity(row.storageIdentityKey),
    epoch: snapshotJournalRevision(row.epoch)
  }
}
/** Bounded recovery DATA only; parsing creates no primary/financial permission. */
export function parsePrimaryHandoffStatus(value: unknown): PrimaryHandoffStatus {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid primary handoff status')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const row = snapshotJournalDataRecord(value, [
    'version',
    'operationId',
    'localStorageIdentityKey',
    'targetStorageIdentityKey',
    'side',
    'phase',
    'localEpoch',
    ...(descriptors.sourceEpoch === undefined ? [] : ['sourceEpoch']),
    ...(descriptors.plan === undefined ? [] : ['plan'])
  ])
  const operationId = primaryHandoffOperation(row.operationId),
    localStorageIdentityKey = primaryHandoffIdentity(row.localStorageIdentityKey),
    targetStorageIdentityKey = primaryHandoffIdentity(row.targetStorageIdentityKey)
  const localEpoch = snapshotJournalRevision(row.localEpoch),
    sourceEpoch = row.sourceEpoch === undefined ? undefined : snapshotJournalRevision(row.sourceEpoch),
    plan = row.plan === undefined ? undefined : canonicalPrimaryHandoffPlan(row.plan as PrimaryHandoffPlan)
  const side = row.side,
    phase = row.phase
  if (
    row.version !== 1 ||
    (side !== 'source' && side !== 'target' && side !== 'backup') ||
    (side === 'source' &&
      (localStorageIdentityKey === targetStorageIdentityKey ||
        sourceEpoch === undefined ||
        !['prepared', 'retired', 'complete', 'cancelled'].includes(String(phase)) ||
        (phase !== 'prepared' && phase !== 'cancelled' && plan === undefined))) ||
    (side === 'target' &&
      (localStorageIdentityKey !== targetStorageIdentityKey ||
        sourceEpoch !== undefined ||
        plan === undefined ||
        !['prepared', 'activated', 'complete', 'cancelled'].includes(String(phase)))) ||
    (side === 'backup' &&
      (localStorageIdentityKey === targetStorageIdentityKey ||
        phase !== 'complete' ||
        sourceEpoch !== undefined ||
        plan === undefined)) ||
    (plan !== undefined &&
      (plan.operationId !== operationId ||
        plan.targetStorageIdentityKey !== targetStorageIdentityKey ||
        (side === 'source' &&
          plan.sources.find(source => source.storageIdentityKey === localStorageIdentityKey)?.epoch !== sourceEpoch)))
  )
    throw new TypeError('Invalid primary handoff status')
  return {
    version: 1,
    operationId,
    localStorageIdentityKey,
    targetStorageIdentityKey,
    side,
    phase: phase as PrimaryHandoffStatus['phase'],
    localEpoch,
    ...(sourceEpoch === undefined ? {} : { sourceEpoch }),
    ...(plan === undefined ? {} : { plan })
  }
}
