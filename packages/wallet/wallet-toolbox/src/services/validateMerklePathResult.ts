import { MerklePath } from '@bsv/sdk'
import { BlockHeader, GetMerklePathResult } from '../sdk/WalletServices.interfaces'
import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { Chain, ReqHistoryNote } from '../sdk/types'
import { WalletError } from '../sdk/WalletError'
import { validateHeaderFormat, validateHeaderProofOfWork } from './chaintracker/chaintracks/util/blockHeaderUtilities'

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/
const MAX_BLOCK_HEIGHT = 0x7fffffff
const MAX_PATH_LEVELS = 32
const MAX_PATH_LEAVES = 4096
const MAX_LEAF_OFFSET = 0x7fffffff
const MAX_PROOF_CANDIDATES = 8
const MAX_PROOF_NOTES = 64
const MAX_NOTE_PROPERTIES = 32

export interface ValidatedMerklePathResult {
  merklePath: MerklePath
  header: BlockHeader
  root: string
  index: number
}

export interface MerkleRootValidator {
  isValidRootForHeight(root: string, height: number): Promise<boolean>
}

export interface SnapshotMerklePathResult extends Omit<GetMerklePathResult, 'merklePath'> {
  merklePath?: MerklePath | MerklePath[]
}

function invalid(name: string, requirement: string): never {
  throw new WERR_INVALID_PARAMETER(name, requirement)
}

export function normalizeTxid(value: unknown, name = 'txid'): string {
  if (typeof value !== 'string' || !HEX_32_BYTES.test(value)) {
    invalid(name, 'exactly 32 hexadecimal bytes')
  }
  return value.toLowerCase()
}

function requirePlainDataRecord(value: unknown, name: string): Record<string, PropertyDescriptor> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(name, 'an accessor-free data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && prototype !== MerklePath.prototype) {
    invalid(name, 'an accessor-free data object')
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(name, 'an accessor-free data object without symbol properties')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
    invalid(name, 'accessor-free data properties')
  }
  return descriptors
}

function ownValue(descriptors: Record<string, PropertyDescriptor>, property: string, name: string): unknown {
  const descriptor = descriptors[property]
  if (descriptor == null || !('value' in descriptor)) invalid(name, `an own ${property} data property`)
  return descriptor.value
}

function optionalOwnValue(descriptors: Record<string, PropertyDescriptor>, property: string): unknown {
  const descriptor = descriptors[property]
  return descriptor != null && 'value' in descriptor ? descriptor.value : undefined
}

function requireDenseArray(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(name, `a dense array of at most ${maximum} items`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(name, 'an array without symbol properties')
  if (Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
    invalid(name, 'an accessor-free array')
  }
  const expectedKeys = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
  if (
    Object.keys(descriptors).some(key => !expectedKeys.has(key)) ||
    expectedKeys.size !== Object.keys(descriptors).length
  ) {
    invalid(name, 'a dense array without extra properties')
  }
  return value
}

function requireInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    invalid(name, `an integer from 0 through ${maximum}`)
  }
  return value as number
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /\p{Cc}/u.test(value)) {
    invalid(name, `at most ${maximum} characters without control characters`)
  }
  return value
}

function copyProofNotes(value: unknown): ReqHistoryNote[] | undefined {
  if (value === undefined) return undefined
  const notes = requireDenseArray(value, 'getMerklePath result.notes', MAX_PROOF_NOTES)
  return notes.map((noteValue, index) => {
    const name = `getMerklePath result.notes[${index}]`
    const descriptors = requirePlainDataRecord(noteValue, name)
    const keys = Object.keys(descriptors)
    if (keys.length > MAX_NOTE_PROPERTIES || keys.some(key => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))) {
      invalid(name, `at most ${MAX_NOTE_PROPERTIES} bounded data properties`)
    }
    const note: Record<string, boolean | string | number | undefined> = {}
    for (const key of keys) {
      const value = ownValue(descriptors, key, name)
      if (value === undefined || typeof value === 'boolean') {
        note[key] = value
      } else if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) {
        note[key] = value
      } else if (typeof value === 'string') {
        note[key] = boundedText(value, `${name}.${key}`, key === 'what' || key === 'when' ? 128 : 512)
      } else {
        invalid(`${name}.${key}`, 'a bounded string, safe integer, boolean, or undefined')
      }
    }
    if (typeof note.what !== 'string' || note.what.length === 0) invalid(`${name}.what`, 'a nonempty bounded string')
    return note as ReqHistoryNote
  })
}

/**
 * Snapshot the provider envelope before inspecting proof availability or
 * diagnostics. The optional legacy array mode is bounded for older custom
 * WalletServices implementations; ordinary providers return one path.
 */
export function snapshotMerklePathResult(
  value: unknown,
  allowLegacyArray = false,
  providerName?: string
): SnapshotMerklePathResult {
  const descriptors = requirePlainDataRecord(value, 'getMerklePath result')
  const allowed = new Set(['name', 'merklePath', 'header', 'error', 'notes'])
  if (Object.keys(descriptors).some(key => !allowed.has(key))) {
    invalid('getMerklePath result', 'only name, merklePath, header, error, and notes data properties')
  }
  const nameValue = providerName ?? optionalOwnValue(descriptors, 'name')
  const name = nameValue === undefined ? undefined : boundedText(nameValue, 'getMerklePath result.name', 128)
  const merklePathValue = optionalOwnValue(descriptors, 'merklePath')
  let merklePath: MerklePath | MerklePath[] | undefined
  if (merklePathValue !== undefined) {
    if (Array.isArray(merklePathValue)) {
      if (!allowLegacyArray) invalid('getMerklePath result.merklePath', 'one MerklePath object')
      merklePath = requireDenseArray(
        merklePathValue,
        'getMerklePath result.merklePath',
        MAX_PROOF_CANDIDATES
      ) as MerklePath[]
    } else {
      merklePath = merklePathValue as MerklePath
    }
  }
  const header = optionalOwnValue(descriptors, 'header') as BlockHeader | undefined
  const errorValue = optionalOwnValue(descriptors, 'error')
  if (errorValue !== undefined && !(errorValue instanceof Error)) {
    invalid('getMerklePath result.error', 'a WalletError or absent')
  }
  const error = errorValue === undefined ? undefined : WalletError.fromUnknown(errorValue)
  const notes = copyProofNotes(optionalOwnValue(descriptors, 'notes'))
  return {
    ...(name !== undefined ? { name } : {}),
    ...(merklePath !== undefined ? { merklePath } : {}),
    ...(header !== undefined ? { header } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(notes !== undefined ? { notes } : {})
  }
}

export function copyMerklePath(txid: string, value: unknown): { merklePath: MerklePath; root: string; index: number } {
  const descriptors = requirePlainDataRecord(value, 'merklePath')
  const blockHeight = requireInteger(
    ownValue(descriptors, 'blockHeight', 'merklePath'),
    'merklePath.blockHeight',
    MAX_BLOCK_HEIGHT
  )
  const sourcePath = requireDenseArray(ownValue(descriptors, 'path', 'merklePath'), 'merklePath.path', MAX_PATH_LEVELS)
  if (sourcePath.length === 0) invalid('merklePath.path', 'at least one level')

  let leafCount = 0
  const path: MerklePath['path'] = sourcePath.map((sourceLevel, levelIndex) => {
    const level = requireDenseArray(sourceLevel, `merklePath.path[${levelIndex}]`, MAX_PATH_LEAVES)
    leafCount += level.length
    if (leafCount > MAX_PATH_LEAVES) invalid('merklePath.path', `at most ${MAX_PATH_LEAVES} total leaves`)
    return level.map((sourceLeaf, leafIndex) => {
      const name = `merklePath.path[${levelIndex}][${leafIndex}]`
      const leafDescriptors = requirePlainDataRecord(sourceLeaf, name)
      const keys = Object.keys(leafDescriptors)
      if (keys.length > 4 || keys.some(key => !['offset', 'hash', 'txid', 'duplicate'].includes(key))) {
        invalid(name, 'only offset, hash, txid, and duplicate data properties')
      }
      const offset = requireInteger(ownValue(leafDescriptors, 'offset', name), `${name}.offset`, MAX_LEAF_OFFSET)
      const hashValue = leafDescriptors.hash?.value
      const txidValue = leafDescriptors.txid?.value
      const duplicateValue = leafDescriptors.duplicate?.value

      if (txidValue !== undefined && txidValue !== true) invalid(`${name}.txid`, 'true or absent')
      if (duplicateValue !== undefined && duplicateValue !== true) invalid(`${name}.duplicate`, 'true or absent')
      if (duplicateValue === true) {
        if (hashValue !== undefined || txidValue !== undefined) {
          invalid(name, 'a duplicate marker without hash or txid properties')
        }
        return { offset, duplicate: true }
      }
      const hash = normalizeTxid(hashValue, `${name}.hash`)
      return txidValue === true ? { offset, hash, txid: true } : { offset, hash }
    })
  })

  let merklePath: MerklePath
  try {
    merklePath = new MerklePath(blockHeight, path)
  } catch {
    invalid('merklePath', 'a structurally consistent bounded Merkle path')
  }
  // A compound proof may mark several transaction leaves, while older proof
  // providers may omit the optional `txid` marker entirely. Membership is
  // bound by the requested hash and the root computation, not by that marker.
  const leaf = merklePath.path[0].find(candidate => candidate.hash === txid)
  if (leaf == null) invalid('merklePath', 'a transaction leaf bound to the requested txid')
  let root: string
  try {
    root = normalizeTxid(merklePath.computeRoot(txid), 'merklePath root')
  } catch {
    invalid('merklePath', 'a path that computes the requested transaction root')
  }
  return { merklePath, root, index: leaf.offset }
}

export function copyValidatedBlockHeader(
  value: unknown,
  requireProofOfWork = false,
  requireHeaderFormat = true,
  chain?: Chain
): BlockHeader {
  const descriptors = requirePlainDataRecord(value, 'header')
  const header: BlockHeader = {
    version: ownValue(descriptors, 'version', 'header') as number,
    previousHash: ownValue(descriptors, 'previousHash', 'header') as string,
    merkleRoot: ownValue(descriptors, 'merkleRoot', 'header') as string,
    time: ownValue(descriptors, 'time', 'header') as number,
    bits: ownValue(descriptors, 'bits', 'header') as number,
    nonce: ownValue(descriptors, 'nonce', 'header') as number,
    height: ownValue(descriptors, 'height', 'header') as number,
    hash: ownValue(descriptors, 'hash', 'header') as string
  }
  if (!Number.isSafeInteger(header.height) || header.height < 0 || header.height > MAX_BLOCK_HEIGHT) {
    invalid('header.height', `an integer from 0 through ${MAX_BLOCK_HEIGHT}`)
  }
  const merkleRoot = normalizeTxid(header.merkleRoot, 'header.merkleRoot')
  const hash = normalizeTxid(header.hash, 'header.hash')
  if (requireHeaderFormat) {
    try {
      validateHeaderFormat(header)
      if (requireProofOfWork) validateHeaderProofOfWork(header, chain)
    } catch {
      invalid(
        'header',
        requireProofOfWork ? 'a canonical proof-of-work-valid block header' : 'a canonical block header'
      )
    }
  }
  return {
    ...header,
    previousHash: typeof header.previousHash === 'string' ? header.previousHash.toLowerCase() : header.previousHash,
    merkleRoot,
    hash
  }
}

export function validateMerklePathResult(
  requestedTxid: unknown,
  result: GetMerklePathResult,
  requireProofOfWork = false,
  requireHeaderFormat = true,
  chain?: Chain
): ValidatedMerklePathResult {
  const txid = normalizeTxid(requestedTxid)
  const descriptors = requirePlainDataRecord(result, 'getMerklePath result')
  const merklePathValue = ownValue(descriptors, 'merklePath', 'getMerklePath result')
  const headerValue = ownValue(descriptors, 'header', 'getMerklePath result')
  const proof = copyMerklePath(txid, merklePathValue)
  const header = copyValidatedBlockHeader(headerValue, requireProofOfWork, requireHeaderFormat, chain)
  if (proof.merklePath.blockHeight !== header.height) {
    invalid('merklePath.blockHeight', 'the authenticated header height')
  }
  if (proof.root !== header.merkleRoot) {
    invalid('merklePath root', 'the authenticated header Merkle root')
  }
  return { ...proof, header }
}

export async function authenticateMerklePathResult(
  requestedTxid: unknown,
  result: GetMerklePathResult,
  validator: MerkleRootValidator,
  requireProofOfWork = false,
  requireHeaderFormat = true,
  chain?: Chain
): Promise<ValidatedMerklePathResult> {
  const validated = validateMerklePathResult(requestedTxid, result, requireProofOfWork, requireHeaderFormat, chain)
  if ((await validator.isValidRootForHeight(validated.root, validated.header.height)) !== true) {
    invalid('merklePath root', 'a root authenticated by the configured chain tracker at the proof height')
  }
  return validated
}
