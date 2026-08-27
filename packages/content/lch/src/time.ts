import { lchAssert } from './errors.js'
import type { LCHUint } from './types.js'

export interface LCHTimeWindow {
  notBefore?: LCHUint
  notAfter?: LCHUint
}

export type LCHTimeWindowStatus = 'not-started' | 'active' | 'expired'

function timestamp(value: LCHUint, field: string): bigint {
  lchAssert(
    typeof value === 'bigint' ? value >= 0n : Number.isSafeInteger(value) && value >= 0,
    'ERR_LCH_LICENSE',
    `${field} must be an unsigned integer timestamp`
  )
  return BigInt(value)
}

export function validateTimeWindow(window: LCHTimeWindow): void {
  const start =
    window.notBefore === undefined ? undefined : timestamp(window.notBefore, 'notBefore')
  const end = window.notAfter === undefined ? undefined : timestamp(window.notAfter, 'notAfter')
  lchAssert(
    start === undefined || end === undefined || start < end,
    'ERR_LCH_LICENSE',
    'Time window must be nonempty'
  )
}

export function timeWindowStatus(window: LCHTimeWindow, now: LCHUint): LCHTimeWindowStatus {
  validateTimeWindow(window)
  const instant = timestamp(now, 'now')
  if (window.notBefore !== undefined && instant < BigInt(window.notBefore)) return 'not-started'
  if (window.notAfter !== undefined && instant >= BigInt(window.notAfter)) return 'expired'
  return 'active'
}

export function requireActiveTimeWindow(window: LCHTimeWindow, now: LCHUint): void {
  lchAssert(
    timeWindowStatus(window, now) === 'active',
    'ERR_LCH_LICENSE',
    'License is outside its active time window'
  )
}
