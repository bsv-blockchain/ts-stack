import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { toArray } from '@bsv/sdk/primitives/utils'
/** Backend-neutral staging limits retain their established public name. */
export interface KnexBrc38StagingLimits {
  readonly maximumRows: number
  readonly maximumLogicalBytes: number
  readonly maximumPhysicalBytes: number
  readonly maximumRowBytes: number
  readonly maximumRowAllocationBytes: number
  /** Fixed wall-clock lease. Reads, retries and sealing never renew it. */
  readonly expiresAt: number
}

/** The caller obtains archiveSha256 from a completed authenticated source.
 * Binding is a resume identity, never evidence that source authentication or
 * target generation validation has happened. All data remains private. */
export interface Brc38StagingBinding {
  readonly archiveSha256: string
  readonly identityKey: string
  readonly chain: 'main' | 'test'
  readonly sourceStorageIdentityKey: string
  readonly targetStorageIdentityKey: string
  readonly targetGeneration: number
}
export interface Brc38StagingBoundMetadata {
  readonly digest: string
  readonly binding: Readonly<Brc38StagingBinding>
  readonly bindingJson: string
  readonly limitsJson: string
}
export function brc38StagingBinding(
  selected: Brc38StagingBinding,
  limits: KnexBrc38StagingLimits
): Brc38StagingBoundMetadata {
  if (typeof selected.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(selected.archiveSha256))
    throw new TypeError('A complete authenticated archive digest is required for resume')
  for (const value of [selected.identityKey, selected.sourceStorageIdentityKey, selected.targetStorageIdentityKey]) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256)
      throw new TypeError('Explicit bounded import profile and destination identities are required')
  }
  if (selected.chain !== 'main' && selected.chain !== 'test') throw new TypeError('Explicit import chain is required')
  if (!Number.isSafeInteger(selected.targetGeneration) || selected.targetGeneration < 0)
    throw new RangeError('A fixed destination generation is required')
  const binding = Object.freeze({
      archiveSha256: selected.archiveSha256,
      identityKey: selected.identityKey,
      chain: selected.chain,
      sourceStorageIdentityKey: selected.sourceStorageIdentityKey,
      targetStorageIdentityKey: selected.targetStorageIdentityKey,
      targetGeneration: selected.targetGeneration
    }),
    bindingJson = JSON.stringify(binding),
    limitsJson = JSON.stringify([
      limits.maximumRows,
      limits.maximumLogicalBytes,
      limits.maximumPhysicalBytes,
      limits.maximumRowBytes,
      limits.maximumRowAllocationBytes,
      limits.expiresAt
    ])
  if (toArray(bindingJson, 'utf8').length > 4096)
    throw new RangeError('Private import binding exceeds its metadata byte policy')
  return Object.freeze({
    binding,
    bindingJson,
    limitsJson,
    digest: new SHA256()
      .update(toArray(JSON.stringify(['brc38-resumable-private/v1', bindingJson, limitsJson]), 'utf8'))
      .digestHex()
  })
}
