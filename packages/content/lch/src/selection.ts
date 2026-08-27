import { lchAssert } from './errors.js'
import type { RangeTuple, Selection } from './types.js'

function asBigInt(value: number | bigint): bigint {
  lchAssert(
    typeof value === 'bigint' || Number.isSafeInteger(value),
    'ERR_LCH_SELECTION',
    'Selection bound is not an integer'
  )
  return BigInt(value)
}

function compareRangeStarts(
  left: readonly [bigint, bigint],
  right: readonly [bigint, bigint]
): number {
  if (left[0] < right[0]) return -1
  if (left[0] > right[0]) return 1
  return 0
}

export function normalizeRanges(ranges: readonly RangeTuple[]): RangeTuple[] {
  lchAssert(ranges.length > 0, 'ERR_LCH_SELECTION', 'Selection ranges cannot be empty')
  const sorted = ranges
    .map(([start, end]) => [asBigInt(start), asBigInt(end)] as const)
    .sort(compareRangeStarts)
  const normalized: Array<[bigint, bigint]> = []
  for (const [start, end] of sorted) {
    lchAssert(
      start >= 0n && start < end,
      'ERR_LCH_SELECTION',
      'Selection range must be nonempty and unsigned'
    )
    const previous = normalized.at(-1)
    if (previous !== undefined && start <= previous[1])
      previous[1] = previous[1] > end ? previous[1] : end
    else normalized.push([start, end])
  }
  return normalized
}

export function normalizeSelection(selection: Selection): Selection {
  if (selection.type === 'all') return selection
  if (selection.type === 'media-fragment') {
    lchAssert(
      selection.value.length > 0 && selection.value.length <= 4096,
      'ERR_LCH_SELECTION',
      'Media fragment is empty or too long'
    )
    return selection
  }
  return { type: selection.type, ranges: normalizeRanges(selection.ranges) }
}

export function validateNormalizedSelection(selection: Selection): void {
  const normalized = normalizeSelection(selection)
  if (
    selection.type === 'all' ||
    selection.type === 'media-fragment' ||
    normalized.type === 'all' ||
    normalized.type === 'media-fragment'
  ) {
    return
  }
  lchAssert(
    selection.ranges.length === normalized.ranges.length &&
      selection.ranges.every(
        ([start, end], index) =>
          BigInt(start) === BigInt(normalized.ranges[index][0]) &&
          BigInt(end) === BigInt(normalized.ranges[index][1])
      ),
    'ERR_LCH_SELECTION',
    'Selection ranges are not normalized'
  )
}

export function selectionsIntersect(left: Selection, right: Selection): boolean {
  if (left.type === 'all' || right.type === 'all') return true
  if (left.type !== right.type || left.type === 'media-fragment' || right.type === 'media-fragment')
    return false
  const leftRanges = normalizeRanges(left.ranges)
  const rightRanges = normalizeRanges(right.ranges)
  return leftRanges.some(([leftStart, leftEnd]) =>
    rightRanges.some(
      ([rightStart, rightEnd]) =>
        asBigInt(leftStart) < asBigInt(rightEnd) && asBigInt(rightStart) < asBigInt(leftEnd)
    )
  )
}

export function selectionQuantity(selection: Selection): bigint {
  lchAssert(
    selection.type !== 'all' && selection.type !== 'media-fragment',
    'ERR_LCH_SELECTION',
    'Selection has no integer quantity'
  )
  return normalizeRanges(selection.ranges).reduce(
    (total, [start, end]) => total + asBigInt(end) - asBigInt(start),
    0n
  )
}
