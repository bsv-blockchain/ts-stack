import type { PrimaryHandoffPlan } from './PrimaryHandoffControl'
import { WERR_INVALID_OPERATION } from '../sdk/WERR_errors'
import { snapshotJournalRevision } from './snapshot/journal/SnapshotJournalRevision'
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Primary handoff intent is invalid or conflicts with pending control')
}
export function primaryHandoffIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    new TextEncoder().encode(value).length > 130 ||
    new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) !== value
  )
    invalid()
  return value
}
export function primaryHandoffOperation(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) invalid()
  return value
}
function exact(value: object, names: string[]): void {
  const keys = Object.keys(value).sort((a, b) => Number(a > b) - Number(a < b)),
    expected = names.sort((a, b) => Number(a > b) - Number(a < b))
  if (JSON.stringify(keys) !== JSON.stringify(expected)) invalid()
}
/** Bounded canonical comparison metadata. Parsing this never creates a SQL
 * capability or proves that any remote source retired or any copy completed. */
export function canonicalPrimaryHandoffPlan(input: PrimaryHandoffPlan): PrimaryHandoffPlan {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) invalid()
  exact(input, ['version', 'operationId', 'targetStorageIdentityKey', 'sources'])
  if (input.version !== 1 || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 8)
    invalid()
  const targetStorageIdentityKey = primaryHandoffIdentity(input.targetStorageIdentityKey)
  const sources = input.sources
    .map(source => {
      if (source == null || typeof source !== 'object' || Array.isArray(source)) invalid()
      exact(source, ['storageIdentityKey', 'epoch'])
      const storageIdentityKey = primaryHandoffIdentity(source.storageIdentityKey)
      if (storageIdentityKey === targetStorageIdentityKey) invalid()
      return { storageIdentityKey, epoch: snapshotJournalRevision(source.epoch) }
    })
    .sort((a, b) =>
      a.storageIdentityKey < b.storageIdentityKey ? -1 : a.storageIdentityKey === b.storageIdentityKey ? 0 : 1
    )
  if (new Set(sources.map(source => source.storageIdentityKey)).size !== sources.length) invalid()
  const plan: PrimaryHandoffPlan = {
    version: 1,
    operationId: primaryHandoffOperation(input.operationId),
    targetStorageIdentityKey,
    sources
  }
  if (JSON.stringify(plan).length > 8192) invalid()
  return plan
}
