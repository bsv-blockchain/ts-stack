import {
  canonicalOutputJSON,
  outputPacketDigest,
  OutputProtocolError,
  type OutputScope
} from '@bsv/sdk'
import type { SourceBatch } from './ports.js'

export interface SourceQuarantineLimits {
  bytes?: number
  receipts?: number
}
/** Local diagnostic record. The complete claim remains in its original receipt journal entry. */
export interface QuarantinedSourceReceipt {
  mutationKey: string
  received: string
  reason: string
  batch: SourceBatch
}

/** Bounded, lossless quarantine; recovery never erases an equivocated identity. */
export class SourceQuarantine {
  private readonly records = new Map<string, QuarantinedSourceReceipt>()
  private readonly maximumBytes: number
  private readonly maximumReceipts: number
  private retainedBytes = 0

  constructor(limits: SourceQuarantineLimits = {}) {
    this.maximumBytes = limits.bytes ?? 16 * 1024 * 1024
    this.maximumReceipts = limits.receipts ?? 64
    for (const [value, maximum] of [
      [this.maximumBytes, 16 * 1024 * 1024],
      [this.maximumReceipts, 64]
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new OutputProtocolError('invalid', 'Invalid source quarantine bound')
  }

  retain(batch: SourceBatch, received: string, reason: string): void {
    const mutation = { kind: 'receive', batch },
      mutationKey = outputPacketDigest('knowledge-mutation', mutation)
    if (this.records.has(mutationKey)) return
    const bytes = new TextEncoder().encode(canonicalOutputJSON(mutation)).length
    if (this.records.size >= this.maximumReceipts || this.retainedBytes + bytes > this.maximumBytes)
      throw new OutputProtocolError('limited', 'Source equivocation quarantine capacity')
    this.records.set(mutationKey, { mutationKey, received, reason, batch: structuredClone(batch) })
    this.retainedBytes += bytes
  }

  entries(): QuarantinedSourceReceipt[] {
    return structuredClone([...this.records.values()])
  }

  /** Summaries deliberately omit private context and evidence bytes. */
  pending(
    isCurrent: (scope: OutputScope, generation: string) => boolean
  ): { scope: OutputScope; groupId: string; reason: string }[] {
    const result: { scope: OutputScope; groupId: string; reason: string }[] = []
    for (const { batch, mutationKey } of this.records.values()) {
      const { scope, generation } = batch.provenance
      if (!isCurrent(scope, generation)) continue
      const ids = batch.groups.length
        ? batch.groups.map(group => group.id)
        : [`quarantine:${mutationKey}`]
      for (const groupId of ids)
        result.push({
          scope,
          groupId,
          reason: 'Source equivocation quarantined; generation reset required'
        })
    }
    return structuredClone(result)
  }

  get bytes(): number {
    return this.retainedBytes
  }
}
