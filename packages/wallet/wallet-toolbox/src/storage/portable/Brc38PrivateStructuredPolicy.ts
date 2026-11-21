import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { isAbsolute, resolve, relative, sep } from 'node:path'

/** Immutable limits for an external private index. These are resource DATA;
 * they grant neither a source lease nor semantic/import authority. */
export interface Brc38PrivateStructuredPolicy {
  readonly privateIndexParent: string
  readonly maximumTemporaryIndexBytes: number
  /** Explicit legacy-spelling mode: at most two simultaneously open indexes,
   * splitting this same aggregate byte allowance. Default retains the original
   * one-shot single-index source contract. */
  readonly maximumOpenIndexes?: 1 | 2
  readonly maximumIndexMembers: number
  readonly maximumStructuredBytes: number
  readonly maximumCanonicalBytes: number
  /** Optional explicit per-read transfer and index working-allocation bounds.
   * These do not establish an aggregate parser/SQLite/VM memory bound. */
  readonly maximumReadBytes?: number
  readonly maximumIndexAllocationBytes?: number
  readonly maximumGrammarAllocationBytes?: number
  readonly workingAllocation?: Brc38WorkingAllocation
  readonly signal?: AbortSignal
}
export function brc38PrivateStructuredPolicy(
  selected: Brc38PrivateStructuredPolicy,
  sourceDirectory?: string
): Readonly<Brc38PrivateStructuredPolicy> {
  const policy = Object.freeze({
    privateIndexParent: selected.privateIndexParent,
    maximumTemporaryIndexBytes: selected.maximumTemporaryIndexBytes,
    maximumIndexMembers: selected.maximumIndexMembers,
    maximumOpenIndexes: selected.maximumOpenIndexes,
    maximumStructuredBytes: selected.maximumStructuredBytes,
    maximumCanonicalBytes: selected.maximumCanonicalBytes,
    maximumReadBytes: selected.maximumReadBytes,
    maximumIndexAllocationBytes: selected.maximumIndexAllocationBytes,
    maximumGrammarAllocationBytes: selected.maximumGrammarAllocationBytes,
    workingAllocation: brc38WorkingAllocation(selected.workingAllocation),
    signal: selected.signal
  })
  const bounded = (value: number, minimum: number, maximum: number) =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum
  if (
    typeof policy.privateIndexParent !== 'string' ||
    !isAbsolute(policy.privateIndexParent) ||
    resolve(policy.privateIndexParent) !== policy.privateIndexParent ||
    !bounded(policy.maximumTemporaryIndexBytes, 1048576, 17179869184) ||
    (policy.maximumOpenIndexes !== undefined && policy.maximumOpenIndexes !== 1 && policy.maximumOpenIndexes !== 2) ||
    (policy.maximumOpenIndexes === 2 && policy.maximumTemporaryIndexBytes < 2097152) ||
    !bounded(policy.maximumIndexMembers, 1, 2000000000) ||
    !bounded(policy.maximumStructuredBytes, 2, 1000000000) ||
    !bounded(policy.maximumCanonicalBytes, 2, 1000000000) ||
    (policy.maximumReadBytes !== undefined && !bounded(policy.maximumReadBytes, 64, 65536)) ||
    (policy.maximumIndexAllocationBytes !== undefined &&
      !bounded(policy.maximumIndexAllocationBytes, 4096, 16777216)) ||
    (policy.maximumGrammarAllocationBytes !== undefined &&
      !bounded(policy.maximumGrammarAllocationBytes, 4096, 16777216))
  )
    throw new RangeError('Invalid private structured staging policy')
  if (sourceDirectory !== undefined) {
    const path = relative(resolve(sourceDirectory), policy.privateIndexParent)
    if (path === '' || (!path.startsWith('..' + sep) && !isAbsolute(path) && path !== '..'))
      throw new Error('External structured index cannot live inside the private SQL kernel directory')
  }
  policy.signal?.throwIfAborted()
  return policy
}
