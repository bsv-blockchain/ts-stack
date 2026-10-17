import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'
import type { Brc38StructuredNativeFieldInventoryPolicy } from './Brc38StructuredNativeFieldInventoryNode'
import { brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'

export type Brc38PrivateStructuredRestoreResources = Pick<
  Brc38StructuredNativeFieldInventoryPolicy,
  'sourcePolicy' | 'projectionPolicy' | 'maximumCombinedTemporaryBytes'
>
export interface Brc38StructuredRestoreResourceData {
  readonly sourcePolicy: Omit<Brc38PrivateStructuredRestoreResources['sourcePolicy'], 'workingAllocation' | 'signal'>
  readonly projectionPolicy: Omit<
    Brc38PrivateStructuredRestoreResources['projectionPolicy'],
    'workingAllocation' | 'signal'
  >
  readonly maximumCombinedTemporaryBytes: number
  readonly maximumWorkingAllocationBytes?: number
}

/** JSON retains bounds, never a live accounting owner or cancellation actor. */
export function brc38StructuredRestoreResourceData(
  selected: Readonly<Brc38PrivateStructuredRestoreResources>
): Readonly<Brc38StructuredRestoreResourceData> {
  const working = brc38WorkingAllocation(
    selected.sourcePolicy.workingAllocation ?? selected.projectionPolicy.workingAllocation
  )
  return Object.freeze({
    sourcePolicy: Object.freeze({ ...selected.sourcePolicy, workingAllocation: undefined, signal: undefined }),
    projectionPolicy: Object.freeze({ ...selected.projectionPolicy, workingAllocation: undefined, signal: undefined }),
    maximumCombinedTemporaryBytes: selected.maximumCombinedTemporaryBytes,
    maximumWorkingAllocationBytes: working?.maximum
  })
}

/** Revalidate persisted DATA without manufacturing its former resource owner.
 * The caller must create and retain one actual owner for its new finite read. */
export function brc38StructuredRestoreResourcesFromData(
  limits: KnexBrc38StagingLimits,
  selected: Brc38StructuredRestoreResourceData,
  maximumStepBytes: number
): Readonly<Brc38PrivateStructuredRestoreResources & { maximumWorkingAllocationBytes: number }> {
  const source = selected.sourcePolicy as Brc38PrivateStructuredRestoreResources['sourcePolicy'],
    projection = selected.projectionPolicy as Brc38PrivateStructuredRestoreResources['projectionPolicy'],
    maximum =
      selected.maximumWorkingAllocationBytes === undefined
        ? limits.maximumRowAllocationBytes
        : selected.maximumWorkingAllocationBytes
  if (
    source.workingAllocation !== undefined ||
    projection.workingAllocation !== undefined ||
    source.signal !== undefined ||
    projection.signal !== undefined ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > Math.min(limits.maximumRowAllocationBytes, 16777216)
  )
    throw new RangeError('Persisted structured resources must contain bounded data only')
  return Object.freeze({
    ...brc38StructuredRestoreResources(limits, selected, maximumStepBytes),
    maximumWorkingAllocationBytes: maximum
  })
}
/** Capture bounded resource DATA only. Actual source/kernel/profile/schema
 * and filesystem ownership checks remain required around every operation. */
export function brc38StructuredRestoreResources(
  limits: KnexBrc38StagingLimits,
  selected: Brc38PrivateStructuredRestoreResources,
  maximumStepBytes: number,
  sourceDirectory?: string
): Readonly<Brc38PrivateStructuredRestoreResources> {
  const sourcePolicy = brc38PrivateStructuredPolicy(selected.sourcePolicy, sourceDirectory),
    value = selected.projectionPolicy,
    projectionPolicy = Object.freeze({
      privateParent: value.privateParent,
      maximumTemporaryFileBytes: value.maximumTemporaryFileBytes,
      maximumMembers: value.maximumMembers,
      maximumOutputBytes: value.maximumOutputBytes,
      maximumScalarBytes: value.maximumScalarBytes,
      maximumIndexAllocationBytes: value.maximumIndexAllocationBytes,
      maximumGrammarAllocationBytes: value.maximumGrammarAllocationBytes,
      workingAllocation: brc38WorkingAllocation(sourcePolicy.workingAllocation ?? value.workingAllocation),
      maximumReadBytes: value.maximumReadBytes,
      expiresAt: value.expiresAt,
      signal: value.signal
    }),
    combined = selected.maximumCombinedTemporaryBytes
  if (
    (sourcePolicy.workingAllocation !== undefined &&
      sourcePolicy.workingAllocation.maximum > limits.maximumRowAllocationBytes) ||
    (projectionPolicy.workingAllocation !== undefined &&
      projectionPolicy.workingAllocation.maximum > limits.maximumRowAllocationBytes) ||
    (sourcePolicy.workingAllocation !== undefined &&
      value.workingAllocation !== undefined &&
      sourcePolicy.workingAllocation !== value.workingAllocation) ||
    projectionPolicy.privateParent !== sourcePolicy.privateIndexParent ||
    projectionPolicy.signal !== sourcePolicy.signal ||
    projectionPolicy.expiresAt !== limits.expiresAt ||
    !Number.isSafeInteger(combined) ||
    combined < 3145728 ||
    combined > 17179869184 ||
    combined > limits.maximumPhysicalBytes ||
    !Number.isSafeInteger(projectionPolicy.maximumTemporaryFileBytes) ||
    projectionPolicy.maximumTemporaryFileBytes < 2097152 ||
    projectionPolicy.maximumTemporaryFileBytes > combined - sourcePolicy.maximumTemporaryIndexBytes ||
    !Number.isSafeInteger(projectionPolicy.maximumMembers) ||
    projectionPolicy.maximumMembers < 1 ||
    projectionPolicy.maximumMembers > 2000000000 ||
    !Number.isSafeInteger(projectionPolicy.maximumOutputBytes) ||
    projectionPolicy.maximumOutputBytes < 2 ||
    projectionPolicy.maximumOutputBytes > sourcePolicy.maximumCanonicalBytes ||
    !Number.isSafeInteger(projectionPolicy.maximumScalarBytes) ||
    projectionPolicy.maximumScalarBytes < 2 ||
    projectionPolicy.maximumScalarBytes > Math.min(maximumStepBytes, limits.maximumRowAllocationBytes) ||
    (projectionPolicy.maximumReadBytes !== undefined &&
      (!Number.isSafeInteger(projectionPolicy.maximumReadBytes) ||
        projectionPolicy.maximumReadBytes < 64 ||
        projectionPolicy.maximumReadBytes > 65536)) ||
    (projectionPolicy.maximumIndexAllocationBytes !== undefined &&
      (!Number.isSafeInteger(projectionPolicy.maximumIndexAllocationBytes) ||
        projectionPolicy.maximumIndexAllocationBytes < 4096 ||
        projectionPolicy.maximumIndexAllocationBytes > limits.maximumRowAllocationBytes)) ||
    (sourcePolicy.maximumIndexAllocationBytes !== undefined &&
      sourcePolicy.maximumIndexAllocationBytes > limits.maximumRowAllocationBytes) ||
    (projectionPolicy.maximumGrammarAllocationBytes !== undefined &&
      (!Number.isSafeInteger(projectionPolicy.maximumGrammarAllocationBytes) ||
        projectionPolicy.maximumGrammarAllocationBytes < 4096 ||
        projectionPolicy.maximumGrammarAllocationBytes > limits.maximumRowAllocationBytes)) ||
    (sourcePolicy.maximumGrammarAllocationBytes !== undefined &&
      sourcePolicy.maximumGrammarAllocationBytes > limits.maximumRowAllocationBytes)
  )
    throw new RangeError('Structured native restore resources differ from their original admission')
  return Object.freeze({ sourcePolicy, projectionPolicy, maximumCombinedTemporaryBytes: combined })
}
