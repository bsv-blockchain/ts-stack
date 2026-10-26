import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { normalizeTxid } from '../validateMerklePathResult'
import type { ArcMinerGetTxData } from './ARC'

const MAX_ARC_MERKLE_PATH_HEX_LENGTH = 2 * 1024 * 1024
const MAX_ARC_COMPETING_TXIDS = 24
const MAX_BLOCK_HEIGHT = 0x7fffffff

function invalidArcData(): never {
  throw new WERR_INVALID_OPERATION('ARC returned malformed transaction data.')
}

function boundedArcText(value: unknown, maximum: number, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > maximum || /\p{Cc}/u.test(value)) invalidArcData()
  return value
}

function denseArcArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARC_COMPETING_TXIDS) invalidArcData()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    invalidArcData()
  }
  const expectedKeys = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
  if (Object.keys(descriptors).some(key => !expectedKeys.has(key)) || Object.keys(descriptors).length !== expectedKeys.size) {
    invalidArcData()
  }
  return value
}

/** Validate and snapshot an untrusted ARC-compatible `GET /tx/{txid}` response. */
export function validateArcTxData(value: unknown, expectedTxid: string, responseStatus = 200): ArcMinerGetTxData {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) invalidArcData()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidArcData()
  if (Object.getOwnPropertySymbols(value).length !== 0) invalidArcData()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(descriptors).length > 32 ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    invalidArcData()
  }
  const read = (property: string): unknown => descriptors[property]?.value

  const txid = normalizeTxid(read('txid'), 'ARC transaction data txid')
  if (txid !== normalizeTxid(expectedTxid)) invalidArcData()
  const txStatus = boundedArcText(read('txStatus'), 64)
  if (!/^[A-Z][A-Z0-9_]*$/.test(txStatus)) invalidArcData()
  const statusValue = read('status') ?? responseStatus
  if (!Number.isSafeInteger(statusValue) || (statusValue as number) < 100 || (statusValue as number) > 599) {
    invalidArcData()
  }

  const blockHashValue = read('blockHash')
  const blockHash =
    blockHashValue == null || blockHashValue === ''
      ? ''
      : normalizeTxid(blockHashValue, 'ARC transaction data blockHash')
  const blockHeightValue = read('blockHeight')
  const blockHeight =
    blockHeightValue == null
      ? 0
      : Number.isSafeInteger(blockHeightValue) &&
          (blockHeightValue as number) >= 0 &&
          (blockHeightValue as number) <= MAX_BLOCK_HEIGHT
        ? (blockHeightValue as number)
        : invalidArcData()
  const merklePath = boundedArcText(read('merklePath'), MAX_ARC_MERKLE_PATH_HEX_LENGTH)
  if (merklePath !== '' && (merklePath.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(merklePath))) invalidArcData()

  const competingValue = read('competingTxs')
  const competingTxs =
    competingValue == null
      ? null
      : denseArcArray(competingValue).map((candidate, index) =>
          normalizeTxid(candidate, `ARC transaction data competingTxs[${index}]`)
        )
  if (competingTxs != null && new Set(competingTxs).size !== competingTxs.length) invalidArcData()

  return {
    status: statusValue as number,
    title: boundedArcText(read('title'), 128),
    blockHash,
    blockHeight,
    competingTxs,
    extraInfo: boundedArcText(read('extraInfo'), 512),
    merklePath: merklePath.toLowerCase(),
    timestamp: boundedArcText(read('timestamp'), 128),
    txid,
    txStatus
  }
}
