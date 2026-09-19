import { isPlainObject, isPublicKeyHex } from './query.js'

/** Body of `GET /economic/params`. Unauthenticated, so every field is a claim, not a fact. */
export interface HostParams {
  version: 1
  host: string
  threshold: number
  topK: number
  floorFeeSats: number
  minPayoutSats: number
  maxQueryTtlMs: number
  classes: string[]
}

const MAX_CLASSES = 64

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

export function parseHostParams(value: unknown): HostParams {
  if (!isPlainObject(value) || value.version !== 1) {
    throw new TypeError('Host params must be a version 1 object')
  }
  if (!isPublicKeyHex(value.host)) throw new TypeError('host must be a compressed public key')
  const classes = value.classes
  if (
    !Array.isArray(classes) ||
    classes.length > MAX_CLASSES ||
    !classes.every(item => typeof item === 'string' && item.length > 0 && item.length <= 64)
  ) {
    throw new TypeError('classes must list query class names')
  }
  return {
    version: 1,
    host: value.host,
    threshold: positiveInteger(value.threshold, 'threshold'),
    topK: positiveInteger(value.topK, 'topK'),
    floorFeeSats: positiveInteger(value.floorFeeSats, 'floorFeeSats'),
    minPayoutSats: positiveInteger(value.minPayoutSats, 'minPayoutSats'),
    maxQueryTtlMs: positiveInteger(value.maxQueryTtlMs, 'maxQueryTtlMs'),
    classes: [...(classes as string[])]
  }
}
