import { MAX_MONITOR_HEIGHT, optionalMonitorInteger } from './monitorValidation'

const MAX_RECOVERY_RANGES = 128
export type RecoveryRange = [number, number]

function parseRange(value: unknown): RecoveryRange | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const min = optionalMonitorInteger(value[0], 0, MAX_MONITOR_HEIGHT)
  const max = optionalMonitorInteger(value[1], 0, MAX_MONITOR_HEIGHT)
  return min !== undefined && max !== undefined && min <= max ? [min, max] : undefined
}

function validReviewedHash(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= 128)
}

/** A bounded, lossless superset of pending heights, persisted in monitor_events. */
export class ReorgRecovery {
  ranges: RecoveryRange[] = []
  cursor = 0
  reviewedHash?: string
  reviewedHeight?: number

  static parse(details: string): ReorgRecovery | undefined {
    if (details.length > 8192) return undefined
    try {
      const value: unknown = JSON.parse(details)
      if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
      const record = value as Record<string, unknown>
      if (!Array.isArray(record.ranges) || record.ranges.length > MAX_RECOVERY_RANGES) return undefined
      const cursor = optionalMonitorInteger(record.cursor, 0, MAX_MONITOR_HEIGHT)
      if (cursor === undefined) return undefined
      if (!validReviewedHash(record.reviewedHash)) return undefined
      const reviewedHeight =
        record.reviewedHeight === undefined
          ? undefined
          : optionalMonitorInteger(record.reviewedHeight, 0, MAX_MONITOR_HEIGHT)
      if (record.reviewedHeight !== undefined && reviewedHeight === undefined) return undefined
      const recovery = new ReorgRecovery()
      recovery.cursor = cursor
      recovery.reviewedHash = record.reviewedHash
      recovery.reviewedHeight = reviewedHeight
      for (const value of record.ranges) {
        const range = parseRange(value)
        if (!range) return undefined
        recovery.add(...range)
      }
      return recovery
    } catch {
      return undefined
    }
  }

  clone(): ReorgRecovery {
    const copy = new ReorgRecovery()
    copy.ranges = this.ranges.map(([min, max]) => [min, max])
    copy.cursor = this.cursor
    copy.reviewedHash = this.reviewedHash
    copy.reviewedHeight = this.reviewedHeight
    return copy
  }

  add(min: number, max: number): void {
    const sorted = [...this.ranges, [min, max] as RecoveryRange].sort((a, b) => a[0] - b[0])
    this.ranges = []
    for (const range of sorted) {
      const last = this.ranges.at(-1)
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
      else this.ranges.push([...range])
    }
    this.boundRanges()
  }

  private boundRanges(): void {
    // Coalescing can add harmless intervening reviews, never remove pending work.
    // 128 pairs of bounded heights keep the checkpoint well below 8192 bytes.
    while (this.ranges.length > MAX_RECOVERY_RANGES) {
      let closest = 0
      for (let i = 1; i < this.ranges.length - 1; i++) {
        if (this.ranges[i + 1][0] - this.ranges[i][1] < this.ranges[closest + 1][0] - this.ranges[closest][1])
          closest = i
      }
      this.ranges.splice(closest, 2, [this.ranges[closest][0], this.ranges[closest + 1][1]])
    }
  }

  next(tipHeight: number, budget: number): RecoveryRange | undefined {
    if (budget <= 0) return undefined
    const eligible = this.ranges.filter(range => range[0] <= tipHeight)
    const range = eligible.find(range => range[1] >= this.cursor) ?? eligible[0]
    if (!range) return undefined
    const start = this.cursor >= range[0] && this.cursor <= Math.min(range[1], tipHeight) ? this.cursor : range[0]
    return [start, Math.min(range[1], tipHeight, start + budget - 1)]
  }

  complete([min, max]: RecoveryRange, unresolved: number[]): void {
    this.ranges = this.ranges.flatMap(([start, end]): RecoveryRange[] => {
      if (end < min || start > max) return [[start, end]]
      const remainder: RecoveryRange[] = []
      if (start < min) remainder.push([start, min - 1])
      if (end > max) remainder.push([max + 1, end])
      return remainder
    })
    for (const height of unresolved) this.add(height, height)
    this.boundRanges()
    this.cursor = max === MAX_MONITOR_HEIGHT ? 0 : max + 1
  }
}
