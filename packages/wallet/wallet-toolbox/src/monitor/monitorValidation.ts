import { PublicKey } from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'
import { BlockHeader } from '../sdk/WalletServices.interfaces'
import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { Chain } from '../sdk/types'
import { isBlockHeader } from '../services/chaintracker/chaintracks/Api/BlockHeaderApi'
import {
  validateHeaderFormat,
  validateHeaderProofOfWork
} from '../services/chaintracker/chaintracks/util/blockHeaderUtilities'

export const MAX_MONITOR_INTERVAL_MSECS = 365 * 24 * 60 * 60 * 1000
export const MAX_MONITOR_PAGE_SIZE = 1000
export const MAX_MONITOR_OFFSET = 0x7fffffff
export const MAX_MONITOR_HEIGHT = 0x7fffffff
const MAX_MONITOR_ATTEMPTS = 1_000_000
const MAX_MONITOR_TAGS = 32
const MAX_MONITOR_TAG_BYTES = 300

export function requireMonitorInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new WERR_INVALID_PARAMETER(name, `an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

export function optionalMonitorInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : undefined
}

export function normalizeMonitorIdentityKey(value: unknown, name = 'identityKey'): string {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-fA-F]{64}$/.test(value)) {
    throw new WERR_INVALID_PARAMETER(name, 'a canonical compressed public key')
  }
  const normalized = value.toLowerCase()
  try {
    if (PublicKey.fromString(normalized).toString() !== normalized) throw new Error('non-canonical')
  } catch {
    throw new WERR_INVALID_PARAMETER(name, 'a canonical compressed public key')
  }
  return normalized
}

export function copyMonitorTags(value: unknown, name = 'tags'): string[] {
  if (!Array.isArray(value) || value.length > MAX_MONITOR_TAGS) {
    throw new WERR_INVALID_PARAMETER(name, `a dense array of at most ${MAX_MONITOR_TAGS} bounded strings`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== expectedKeys.size ||
    Object.keys(descriptors).some(key => !expectedKeys.has(key)) ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    throw new WERR_INVALID_PARAMETER(name, 'an accessor-free dense array without extra properties')
  }
  return Array.from({ length: value.length }, (_, index) => {
    const tag = descriptors[String(index)].value
    if (
      typeof tag !== 'string' ||
      tag.length === 0 ||
      toArray(tag, 'utf8').length > MAX_MONITOR_TAG_BYTES ||
      /\p{Cc}/u.test(tag)
    ) {
      throw new WERR_INVALID_PARAMETER(
        `${name}[${index}]`,
        `1 through ${MAX_MONITOR_TAG_BYTES} UTF-8 bytes without control characters`
      )
    }
    return tag
  })
}

export function copyValidatedMonitorHeader(
  value: unknown,
  name = 'header',
  requireProofOfWork = true,
  chain?: Chain
): BlockHeader {
  if (!isBlockHeader(value as BlockHeader)) {
    throw new WERR_INVALID_PARAMETER(name, 'an accessor-free block-header data object')
  }
  const source = value as BlockHeader
  const header: BlockHeader = {
    version: source.version,
    previousHash: source.previousHash,
    merkleRoot: source.merkleRoot,
    time: source.time,
    bits: source.bits,
    nonce: source.nonce,
    height: source.height,
    hash: source.hash
  }
  try {
    validateHeaderFormat(header)
    if (requireProofOfWork) validateHeaderProofOfWork(header, chain)
  } catch {
    throw new WERR_INVALID_PARAMETER(
      name,
      requireProofOfWork ? 'a canonical proof-of-work-valid block header' : 'a canonical block header'
    )
  }
  return header
}

export function validateMonitorOptions(value: unknown): void {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WERR_INVALID_PARAMETER('options', 'an accessor-free plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WERR_INVALID_PARAMETER('options', 'an accessor-free plain data object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    throw new WERR_INVALID_PARAMETER('options', 'accessor-free data properties without symbols')
  }
  const read = (property: string): unknown => descriptors[property]?.value
  requireMonitorInteger(
    read('msecsWaitPerMerkleProofServiceReq'),
    'msecsWaitPerMerkleProofServiceReq',
    0,
    MAX_MONITOR_INTERVAL_MSECS
  )
  requireMonitorInteger(read('taskRunWaitMsecs'), 'taskRunWaitMsecs', 0, MAX_MONITOR_INTERVAL_MSECS)
  requireMonitorInteger(read('abandonedMsecs'), 'abandonedMsecs', 0, MAX_MONITOR_INTERVAL_MSECS)
  requireMonitorInteger(read('unprovenAttemptsLimitTest'), 'unprovenAttemptsLimitTest', 0, MAX_MONITOR_ATTEMPTS)
  requireMonitorInteger(read('unprovenAttemptsLimitMain'), 'unprovenAttemptsLimitMain', 0, MAX_MONITOR_ATTEMPTS)
  requireMonitorInteger(read('maxRebroadcastAttempts'), 'maxRebroadcastAttempts', 0, MAX_MONITOR_ATTEMPTS)

  for (const property of [
    'logging',
    'loadLastSSEEventId',
    'saveLastSSEEventId',
    'onTransactionBroadcasted',
    'onTransactionProven',
    'onTransactionStatusChanged'
  ]) {
    const candidate = read(property)
    if (candidate !== undefined && typeof candidate !== 'function') {
      throw new WERR_INVALID_PARAMETER(property, 'a function or absent')
    }
  }
  const eventSourceClass = read('EventSourceClass')
  if (eventSourceClass !== undefined && typeof eventSourceClass !== 'function') {
    throw new WERR_INVALID_PARAMETER('EventSourceClass', 'a constructor or absent')
  }
}
