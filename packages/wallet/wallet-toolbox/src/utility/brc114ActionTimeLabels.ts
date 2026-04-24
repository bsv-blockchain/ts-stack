import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'

export interface ParsedBrc114ActionTimeLabels {
  from?: number
  to?: number
  timeFilterRequested: boolean
  remainingLabels: string[]
}

export function parseBrc114ActionTimeLabels (labels: string[] | undefined): ParsedBrc114ActionTimeLabels {
  let from: number | undefined
  let to: number | undefined
  const remainingLabels: string[] = []
  let timeFilterRequested = false

  for (const label of labels || []) {
    if (label.startsWith('action time from ')) {
      timeFilterRequested = true
      if (from !== undefined) throw new WERR_INVALID_PARAMETER('labels', 'valid. Duplicate action time from label.')
      const v = label.slice('action time from '.length)
      if (!/^[0-9]+$/.test(v)) { throw new WERR_INVALID_PARAMETER('labels', 'valid. Invalid action time from timestamp value.') }
      const n = Number(v)
      if (!Number.isSafeInteger(n) || n < 0) { throw new WERR_INVALID_PARAMETER('labels', 'valid. Invalid action time from timestamp value.') }
      if (Number.isNaN(new Date(n).getTime())) { throw new WERR_INVALID_PARAMETER('labels', 'valid. Invalid action time from timestamp value.') }
      from = n
      continue
    }

    if (label.startsWith('action time to ')) {
      timeFilterRequested = true
      if (to !== undefined) throw new WERR_INVALID_PARAMETER('labels', 'valid. Duplicate action time to label.')
      const v = label.slice('action time to '.length)
      if (!/^[0-9]+$/.test(v)) { throw new WERR_INVALID_PARAMETER('labels', 'valid. Invalid action time to timestamp value.') }
      const n = Number(v)
      if (!Number.isSafeInteger(n) || n < 0) { throw new WERR_INVALID_PARAMETER('labels', 'valid. Invalid action time to timestamp value.') }
      if (Number.isNaN(new Date(n).getTime())) { throw new WERR_INVALID_PARAMETER('labels', 'valid. Invalid action time to timestamp value.') }
      to = n
      continue
    }

    remainingLabels.push(label)
  }

  if (from !== undefined && to !== undefined && from >= to) { throw new WERR_INVALID_PARAMETER('labels', 'valid. action time from must be less than action time to.') }

  return { from, to, timeFilterRequested, remainingLabels }
}

export function makeBrc114ActionTimeLabel (unixMillis: number): string {
  return `action time ${unixMillis}`
}
