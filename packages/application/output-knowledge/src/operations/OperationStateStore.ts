import {
  canonicalOutputJSON,
  parseOutputJSON,
  outputString,
  outputU64,
  incrementOutputU64,
  OutputProtocolError,
  Hash,
  Utils,
  type OutputJSONObject
} from '@bsv/sdk'

/** Bounded local workflow state. This is not a Bitcoin receipt or remote authority. */
export interface OperationStateSnapshot {
  revision: string
  value: OutputJSONObject
}
export interface OperationStateResult {
  status: 'updated' | 'replayed' | 'conflict'
  revision: string
}
export interface OperationStateStore {
  readonly namespace: string
  readonly durability: 'volatile' | 'durable'
  /** Owned copies of the immutable binding and capacities; validate these when composing ports. */
  readonly configuration: { binding: OutputJSONObject; limits: OperationStateLimits }
  read(): Promise<OperationStateSnapshot>
  compareAndSwap(expectedRevision: string, value: OutputJSONObject): Promise<OperationStateResult>
  close(): Promise<void>
}
export interface OperationStateLimits {
  /** Includes the immutable namespace, binding and limit envelope. */
  configurationBytes: number
  /** Mutable state is stored separately from configuration. */
  stateBytes: number
}
export const DEFAULT_OPERATION_STATE_LIMITS: Readonly<OperationStateLimits> = Object.freeze({
  configurationBytes: 2 * 1024 * 1024,
  stateBytes: 4 * 1024 * 1024
})

export interface StoredOperationState {
  configuration: string
  initialDigest: string
  revision: string
  text: string
  digest: string
  checksum: string
}

function objectValue(text: string, maximum: number): OutputJSONObject {
  const value = parseOutputJSON(text, { bytes: maximum })
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new OutputProtocolError('invalid', 'Operation state must be a JSON object')
  return value
}
const digest = (text: string): string =>
  Utils.toHex(Hash.sha256(Utils.toArray('output-operation-state/1\0' + text, 'utf8')))
const checksum = (row: Omit<StoredOperationState, 'checksum'>): string =>
  digest([digest(row.configuration), row.initialDigest, row.revision, row.digest].join(':'))

/** Shared storage framing; workflow-specific transition validation remains above this port. */
export class OperationStateCodec {
  readonly limits: OperationStateLimits
  readonly configuration: string

  constructor(
    readonly namespace: string,
    binding: OutputJSONObject,
    limits: Partial<OperationStateLimits> = {}
  ) {
    outputString(namespace)
    this.limits = { ...DEFAULT_OPERATION_STATE_LIMITS, ...limits }
    for (const key of Object.keys(this.limits) as (keyof OperationStateLimits)[])
      if (
        !Object.hasOwn(DEFAULT_OPERATION_STATE_LIMITS, key) ||
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > DEFAULT_OPERATION_STATE_LIMITS[key]
      )
        throw new OutputProtocolError('invalid', 'Invalid operation state limit')
    this.configuration = canonicalOutputJSON(
      { format: 'output-operation-state/1', namespace, binding, limits: this.limits },
      { bytes: this.limits.configurationBytes }
    )
    objectValue(canonicalOutputJSON(binding), this.limits.configurationBytes)
    Object.freeze(this.limits)
  }

  encode(value: OutputJSONObject): { text: string; digest: string } {
    const text = canonicalOutputJSON(value, { bytes: this.limits.stateBytes })
    objectValue(text, this.limits.stateBytes)
    return { text, digest: digest(text) }
  }

  configurationValue(): { binding: OutputJSONObject; limits: OperationStateLimits } {
    const value = JSON.parse(this.configuration) as { binding: OutputJSONObject }
    return { binding: value.binding, limits: { ...this.limits } }
  }

  initial(value: OutputJSONObject): StoredOperationState {
    const encoded = this.encode(value)
    const row = {
      configuration: this.configuration,
      initialDigest: encoded.digest,
      revision: '0',
      ...encoded
    }
    return { ...row, checksum: checksum(row) }
  }

  snapshot(row: StoredOperationState): OperationStateSnapshot {
    if (row.configuration !== this.configuration)
      throw new OutputProtocolError('context-changed', 'Operation state binding or limits changed')
    outputU64(row.revision)
    if (!/^[0-9a-f]{64}$/.test(row.initialDigest))
      throw new OutputProtocolError('reset-required', 'Invalid operation initialization digest')
    const value = objectValue(row.text, this.limits.stateBytes)
    if (
      canonicalOutputJSON(value, { bytes: this.limits.stateBytes }) !== row.text ||
      digest(row.text) !== row.digest ||
      checksum(row) !== row.checksum ||
      (row.revision === '0' && row.digest !== row.initialDigest)
    )
      throw new OutputProtocolError('reset-required', 'Operation state integrity failed')
    return { revision: row.revision, value }
  }

  plan(
    row: StoredOperationState,
    expected: string,
    encoded: { text: string; digest: string }
  ): { result: OperationStateResult; next?: StoredOperationState } {
    this.snapshot(row)
    const revision = incrementOutputU64(expected)
    if (row.revision === expected) {
      const next = { ...row, revision, ...encoded }
      next.checksum = checksum(next)
      return {
        result: { status: 'updated', revision },
        next
      }
    }
    // Only the immediately following, byte-identical state proves this exact CAS.
    // A later revision is a conflict, never proof that an uncertain write rolled back.
    return {
      result: {
        status: row.revision === revision && row.text === encoded.text ? 'replayed' : 'conflict',
        revision: row.revision
      }
    }
  }
}
