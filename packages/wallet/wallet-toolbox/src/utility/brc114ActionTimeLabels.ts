import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'

export interface ParsedBrc114ActionTimeLabels {
  from?: number
  to?: number
  timeFilterRequested: boolean
  remainingLabels: string[]
}

const FROM_PREFIX = 'action time from '
const TO_PREFIX = 'action time to '

function parseActionTimeBound(label: string, prefix: string, bound: 'from' | 'to'): number {
  const value = label.slice(prefix.length)
  const invalid = `valid. Invalid action time ${bound} timestamp value.`
  if (!/^\d+$/.test(value)) throw new WERR_INVALID_PARAMETER('labels', invalid)
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new WERR_INVALID_PARAMETER('labels', invalid)
  }
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new WERR_INVALID_PARAMETER('labels', invalid)
  }
  return timestamp
}

function setActionTimeBound(current: number | undefined, label: string, prefix: string, bound: 'from' | 'to'): number {
  if (current !== undefined) {
    throw new WERR_INVALID_PARAMETER('labels', `valid. Duplicate action time ${bound} label.`)
  }
  return parseActionTimeBound(label, prefix, bound)
}

export function parseBrc114ActionTimeLabels(labels: string[] | undefined): ParsedBrc114ActionTimeLabels {
  let from: number | undefined
  let to: number | undefined
  const remainingLabels: string[] = []
  let timeFilterRequested = false

  for (const label of labels ?? []) {
    if (label.startsWith(FROM_PREFIX)) {
      timeFilterRequested = true
      from = setActionTimeBound(from, label, FROM_PREFIX, 'from')
      continue
    }

    if (label.startsWith(TO_PREFIX)) {
      timeFilterRequested = true
      to = setActionTimeBound(to, label, TO_PREFIX, 'to')
      continue
    }

    remainingLabels.push(label)
  }

  if (from !== undefined && to !== undefined && from >= to) {
    throw new WERR_INVALID_PARAMETER('labels', 'valid. action time from must be less than action time to.')
  }

  return { from, to, timeFilterRequested, remainingLabels }
}

export function makeBrc114ActionTimeLabel(unixMillis: number): string {
  return `action time ${unixMillis}`
}
