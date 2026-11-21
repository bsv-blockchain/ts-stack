import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

/** Portable preflight/clone DATA rules, preserving the existing native model.
 * No source, backend, semantic or activation grant is created by a clone. */
export interface Brc38ImportDecodedBudget {
  remaining: number
  readonly maximum: number
  readonly signal?: AbortSignal
}
type Budget = Brc38ImportDecodedBudget
function invalid(): never {
  throw new Error('Private import merge differs from its prepared entity or ownership')
}
export function chargeBrc38ImportDecodedBudget(budget: Budget, bytes: number): void {
  budget.signal?.throwIfAborted()
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.remaining)
    throw new SnapshotResourceLimitError('Private import merge exceeds its fixed allocation budget')
  budget.remaining -= bytes
}
/** Account for a temporary phase alongside retained page data. The owner may
 * release once only after its buffers and actual I/O have drained. A failed
 * phase keeps this reservation; a rollback cannot release retained copies.
 * This is resource accounting, never source/native/import authority. */
export function reserveBrc38ImportDecodedScratch(budget: Budget, bytes: number): () => void {
  if (
    !Number.isSafeInteger(budget.maximum) ||
    !Number.isSafeInteger(budget.remaining) ||
    budget.maximum < 1 ||
    budget.remaining < 0 ||
    budget.remaining > budget.maximum
  )
    throw new RangeError('Invalid original decoded allocation balance')
  chargeBrc38ImportDecodedBudget(budget, bytes)
  let released = false
  return () => {
    if (released) return
    const next = budget.remaining + bytes
    if (!Number.isSafeInteger(next) || next < 0 || next > budget.maximum)
      throw new RangeError('Invalid decoded scratch release balance')
    budget.remaining = next
    released = true
  }
}
const take = chargeBrc38ImportDecodedBudget
export function copyBrc38ImportDecodedValue<T>(value: T, budget: Budget): T {
  // Charge before clone, including retained native/normalized/captured copies.
  // This policy is distinct from logical archive bytes and physical disk quota.
  allocation(value, budget, new Set(), 0)
  return cloneBrc38ImportDecodedValue(value) as T
}
/** Internal clone of data ALREADY covered by the original preflight budget. */
export function cloneBrc38ImportDecodedValue(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.getTime())
  if (Array.isArray(value)) return value.map(cloneBrc38ImportDecodedValue)
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(value)) result[key] = cloneBrc38ImportDecodedValue(Reflect.get(value, key))
  return result
}
export function chargeBrc38ImportDecodedValue(budget: Budget, value: unknown): void {
  allocation(value, budget, new Set(), 0)
}
function properties(value: object, budget: Budget, active: Set<object>, depth: number): void {
  if (Array.isArray(value)) {
    take(budget, 256 + 64 * value.length)
    for (const child of value) allocation(child, budget, active, depth + 1)
    return
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) invalid()
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    take(budget, 256 + 8 * key.length)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) invalid()
    allocation(descriptor.value, budget, active, depth + 1)
  }
}
function allocation(value: unknown, budget: Budget, active: Set<object>, depth: number): void {
  take(budget, 256)
  if (depth > 64) throw new SnapshotResourceLimitError('Private import merge nesting exceeds64 levels')
  if (typeof value === 'string') {
    take(budget, 8 * value.length)
    return
  }
  if (value === undefined || value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
    return
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) invalid()
    return
  }
  if (typeof value !== 'object' || active.has(value)) invalid()
  active.add(value)
  try {
    properties(value, budget, active, depth)
  } finally {
    active.delete(value)
  }
}
