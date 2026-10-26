import { validateAgainstDirtyHashes } from './dirtyHashes'
import { BigNumber } from '@bsv/sdk'
import { SHA256, sha256 } from '@bsv/sdk/primitives/Hash'
import { ReaderUint8Array, Writer, toBase64 } from '@bsv/sdk/primitives/utils'
import { asArray, asString } from '../../../../utility/utilityHelpers.noBuffer'
import { doubleSha256BE } from '../../../../utility/utilityHelpers'
import { Chain } from '../../../../sdk/types'
import { ChaintracksFsApi } from '../Api/ChaintracksFsApi'
import { BulkHeaderFileInfo } from './BulkHeaderFile'
import { ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../../sdk/WERR_errors'
import { BaseBlockHeader, BlockHeader } from '../../../../sdk/WalletServices.interfaces'

const MAX_HEADER_COUNT = 100_000
const MAX_HEADER_BYTES = MAX_HEADER_COUNT * 80
const MAX_BLOCK_HEIGHT = 0x7fffffff
const UINT32_MAX = 0xffffffff
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/

function validateByteWindow(
  buffer: unknown,
  offset: number,
  length: number,
  name = 'buffer'
): asserts buffer is number[] | Uint8Array {
  if (!Array.isArray(buffer) && !(buffer instanceof Uint8Array)) {
    throw new WERR_INVALID_PARAMETER(name, 'a byte array')
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(offset + length) ||
    offset + length > buffer.length
  ) {
    throw new WERR_INVALID_PARAMETER(`${name} window`, 'non-negative safe integers within the byte array')
  }
  if (Array.isArray(buffer)) {
    for (let index = offset; index < offset + length; index++) {
      const value = buffer[index]
      if (!Number.isInteger(value) || value < 0 || value > 0xff) {
        throw new WERR_INVALID_PARAMETER(name, 'an array of byte integers')
      }
    }
  }
}

function validateWritableByteWindow(
  buffer: unknown,
  offset: number,
  length: number
): asserts buffer is number[] | Uint8Array {
  if (!Array.isArray(buffer) && !(buffer instanceof Uint8Array)) {
    throw new WERR_INVALID_PARAMETER('buffer', 'a writable byte array')
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(offset + length) ||
    offset + length > buffer.length
  ) {
    throw new WERR_INVALID_PARAMETER('offset', `a non-negative safe integer with ${length} writable bytes`)
  }
}

function validateWork(value: unknown, name: string): BigNumber {
  if (typeof value !== 'string' || !HEX_32_BYTES.test(value)) {
    throw new WERR_INVALID_PARAMETER(name, 'exactly 32 hexadecimal bytes')
  }
  return new BigNumber(value, 16)
}

function copyBaseHeaderData(value: unknown): BaseBlockHeader {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WERR_INVALID_PARAMETER('header', 'a plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WERR_INVALID_PARAMETER('header', 'a plain data object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
    throw new WERR_INVALID_PARAMETER('header', 'accessor-free data properties')
  }
  const read = (name: string): unknown => {
    const descriptor = descriptors[name]
    if (descriptor == null || !('value' in descriptor)) {
      throw new WERR_INVALID_PARAMETER('header', `an own ${name} data property`)
    }
    return descriptor.value
  }
  return {
    version: read('version') as number,
    previousHash: read('previousHash') as string,
    merkleRoot: read('merkleRoot') as string,
    time: read('time') as number,
    bits: read('bits') as number,
    nonce: read('nonce') as number
  }
}

/**
 * Computes sha256 hash of file contents read as bytes with no encoding.
 * @param filepath Full filepath to file.
 * @param bufferSize Optional read buffer size to use. Defaults to 80,000 bytes. Currently ignored.
 * @returns `{hash, length}` where `hash` is base64 string form of file hash and `length` is file length in bytes.
 */
export async function sha256HashOfBinaryFile(
  fs: ChaintracksFsApi,
  filepath: string,
  bufferSize = 80000
): Promise<{ hash: string; length: number }> {
  if (!Number.isSafeInteger(bufferSize) || bufferSize < 1 || bufferSize > MAX_HEADER_BYTES) {
    throw new WERR_INVALID_PARAMETER('bufferSize', `an integer from 1 through ${MAX_HEADER_BYTES}`)
  }
  const hasher = new SHA256()
  const file = await fs.openReadableFile(filepath)
  try {
    const length = await file.getLength()
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HEADER_BYTES) {
      throw new WERR_INVALID_PARAMETER('file length', `an integer from 0 through ${MAX_HEADER_BYTES}`)
    }
    let offset = 0
    while (offset < length) {
      const requested = Math.min(bufferSize, length - offset)
      const bytes = await file.read(requested, offset)
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > requested) {
        throw new Error('Binary file reader returned an invalid or incomplete chunk.')
      }
      hasher.update(asArray(bytes))
      offset += bytes.length
    }
    return { hash: toBase64(hasher.digest()), length }
  } finally {
    await file.close()
  }
}

/**
 * Validates the contents of a bulk header file.
 * @param bf BulkHeaderFileInfo containing `data` to validate.
 * @param prevHash Required previous header hash.
 * @param prevChainWork Required previous chain work.
 * @param fetch Optional ChaintracksFetchApi instance for fetching data.
 * @returns Validated BulkHeaderFileInfo with `validated` set to true.
 */
export async function validateBulkFileData(
  bf: BulkHeaderFileInfo,
  prevHash: string,
  prevChainWork: string,
  fetch?: ChaintracksFetchApi
): Promise<BulkHeaderFileInfo> {
  if (bf == null || typeof bf !== 'object' || Array.isArray(bf)) {
    throw new WERR_INVALID_PARAMETER('bf', 'a plain data object')
  }
  const prototype = Object.getPrototypeOf(bf)
  const descriptors = Object.getOwnPropertyDescriptors(bf)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    throw new WERR_INVALID_PARAMETER('bf', 'an accessor-free plain data object')
  }
  const vbf = { ...bf }

  if (!Number.isSafeInteger(vbf.count) || vbf.count <= 0 || vbf.count > MAX_HEADER_COUNT) {
    throw new WERR_INVALID_PARAMETER('bf.count', `an integer from 1 through ${MAX_HEADER_COUNT}`)
  }

  if (!Number.isSafeInteger(vbf.firstHeight) || vbf.firstHeight < 0 || vbf.firstHeight > MAX_BLOCK_HEIGHT) {
    throw new WERR_INVALID_PARAMETER('bf.firstHeight', `an integer from 0 through ${MAX_BLOCK_HEIGHT}`)
  }
  if (vbf.firstHeight + vbf.count - 1 > MAX_BLOCK_HEIGHT) {
    throw new WERR_INVALID_PARAMETER('bf', 'a header range within the supported block heights')
  }
  if (!['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'].includes(vbf.chain!)) {
    throw new WERR_INVALID_PARAMETER('bf.chain', 'a supported Chaintracks network')
  }
  if (
    typeof vbf.fileName !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/.test(vbf.fileName) ||
    vbf.fileName === '.' ||
    vbf.fileName === '..'
  ) {
    throw new WERR_INVALID_PARAMETER('bf.fileName', 'a safe path-free ASCII file name')
  }
  if (typeof prevHash !== 'string' || !HEX_32_BYTES.test(prevHash)) {
    throw new WERR_INVALID_PARAMETER('prevHash', 'exactly 32 hexadecimal bytes')
  }
  validateWork(prevChainWork, 'prevChainWork')

  if (vbf.data == null && vbf.sourceUrl && fetch != null) {
    const url = fetch.pathJoin(vbf.sourceUrl, vbf.fileName)
    vbf.data = await fetch.download(url, vbf.count * 80)
  }

  if (vbf.data == null) throw new WERR_INVALID_OPERATION(`bulk file ${vbf.fileName} data is unavailable`)
  if (!(vbf.data instanceof Uint8Array)) throw new WERR_INVALID_PARAMETER('bf.data', 'a Uint8Array')

  if (vbf.data.length !== vbf.count * 80) {
    throw new WERR_INVALID_PARAMETER(
      'bf.data',
      `bulk file ${vbf.fileName} data length ${vbf.data.length} does not match expected count ${vbf.count}`
    )
  }

  vbf.fileHash = asString(sha256(asArray(vbf.data)), 'base64')
  if (bf.fileHash && bf.fileHash !== vbf.fileHash) {
    throw new WERR_INVALID_PARAMETER('bf.fileHash', `expected ${bf.fileHash} but got ${vbf.fileHash}`)
  }

  const { lastHeaderHash, lastChainWork } = validateBufferOfHeaders(
    vbf.data,
    prevHash,
    0,
    undefined,
    prevChainWork,
    vbf.chain
  )
  if (
    bf.lastHash &&
    (typeof bf.lastHash !== 'string' || !HEX_32_BYTES.test(bf.lastHash) || bf.lastHash.toLowerCase() !== lastHeaderHash)
  ) {
    throw new WERR_INVALID_PARAMETER('bf.lastHash', `expected ${bf.lastHash} but got ${lastHeaderHash}`)
  }
  if (
    bf.lastChainWork &&
    (typeof bf.lastChainWork !== 'string' ||
      !HEX_32_BYTES.test(bf.lastChainWork) ||
      bf.lastChainWork.toLowerCase() !== lastChainWork)
  ) {
    throw new WERR_INVALID_PARAMETER('bf.lastChainWork', `expected ${bf.lastChainWork} but got ${lastChainWork}`)
  }
  vbf.lastHash = lastHeaderHash
  vbf.lastChainWork = lastChainWork!
  if (vbf.firstHeight === 0) {
    validateGenesisHeader(vbf.data, vbf.chain!)
  }
  vbf.validated = true

  return vbf
}

/**
 * Validate headers contained in an array of bytes. The headers must be consecutive block headers, 80 bytes long,
 *  where the hash of each header equals the previousHash of the following header.
 * @param buffer Buffer of headers to be validated.
 * @param previousHash Expected previousHash of first header.
 * @param offset Optional starting offset within `buffer`.
 * @param count Optional number of headers to validate. Validates to end of buffer if missing.
 * @param previousChainWork Optional chain work through `previousHash`; when present, the result carries it forward.
 * @param chain Optional chain the headers belong to. Selects its proof-of-work limit
 *   (see `proofOfWorkLimitBits`); omitted means the mainnet limit.
 * @returns Header hash of last header validated or previousHash if there where none.
 */
export function validateBufferOfHeaders(
  buffer: Uint8Array,
  previousHash: string,
  offset = 0,
  count = -1,
  previousChainWork?: string,
  chain?: Chain
): { lastHeaderHash: string; lastChainWork: string | undefined } {
  if (!(buffer instanceof Uint8Array)) throw new WERR_INVALID_PARAMETER('buffer', 'a Uint8Array')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) {
    throw new WERR_INVALID_PARAMETER('offset', 'a non-negative safe integer within the buffer')
  }
  if (!Number.isSafeInteger(count) || count < -1 || count > MAX_HEADER_COUNT) {
    throw new WERR_INVALID_PARAMETER('count', `-1 or an integer from 0 through ${MAX_HEADER_COUNT}`)
  }
  if (count < 0) {
    if ((buffer.length - offset) % 80 !== 0) {
      throw new WERR_INVALID_PARAMETER('buffer', 'a complete sequence of 80-byte headers')
    }
    count = (buffer.length - offset) / 80
  }
  if (count > MAX_HEADER_COUNT || offset + count * 80 > buffer.length) {
    throw new WERR_INVALID_PARAMETER('buffer', 'enough bytes for the bounded requested header count')
  }
  if (typeof previousHash !== 'string' || !HEX_32_BYTES.test(previousHash)) {
    throw new WERR_INVALID_PARAMETER('previousHash', 'exactly 32 hexadecimal bytes')
  }
  let lastHeaderHash = previousHash.toLowerCase()
  let lastChainWork = previousChainWork
  if (lastChainWork !== undefined) {
    validateWork(lastChainWork, 'previousChainWork')
    lastChainWork = lastChainWork.toLowerCase()
  }
  for (let i = 0; i < count; i++) {
    const headerStart = offset + i * 80
    const headerEnd = headerStart + 80
    if (headerEnd > buffer.length) {
      throw new WERR_INVALID_PARAMETER(
        'buffer',
        `multiple of 80 bytes long. header ${i} missing bytes for header at offset ${headerStart} in buffer of length ${buffer.length}`
      )
    }
    const header = buffer.slice(headerStart, headerEnd)
    const h = deserializeBaseBlockHeader(header)
    const hashPrev = asString(header.slice(4, 36).reverse())
    if (lastHeaderHash !== hashPrev) {
      throw new Error(`header ${i} invalid previousHash ${lastHeaderHash} vs ${hashPrev}`)
    }
    lastHeaderHash = asString(doubleSha256BE(header))
    validateAgainstDirtyHashes(lastHeaderHash)
    validateConsensusProofOfWork(lastHeaderHash, h.bits, chain)
    if (lastChainWork) {
      lastChainWork = addWork(lastChainWork, convertBitsToWork(h.bits, chain))
    }
  }
  return { lastHeaderHash, lastChainWork }
}

/**
 * Verifies that buffer begins with valid genesis block header for the specified chain.
 * @param buffer
 * @param chain
 */
export function validateGenesisHeader(buffer: Uint8Array, chain: Chain): void {
  const header = buffer.slice(0, 80)
  const h = deserializeBlockHeader(header, 0)
  const gh = genesisHeader(chain)
  if (
    h.bits !== gh.bits ||
    h.previousHash !== gh.previousHash ||
    h.merkleRoot !== gh.merkleRoot ||
    h.time !== gh.time ||
    h.nonce !== gh.nonce ||
    h.version !== gh.version ||
    h.height !== gh.height ||
    h.hash !== gh.hash
  ) {
    throw new WERR_INVALID_PARAMETER('buffer', `genesis header for chain ${chain}`)
  }
}

/**
 * @param work chainWork as a BigNumber
 * @returns Converted chainWork value from BN to hex string of 32 bytes.
 */
export function workBNtoBuffer(work: BigNumber): string {
  const encoded = work.toString(16)
  if (!/^[0-9a-f]+$/i.test(encoded) || encoded.length > 64) {
    throw new WERR_INVALID_PARAMETER('work', 'a non-negative integer no greater than 256 bits')
  }
  return encoded.toLowerCase().padStart(64, '0')
}

/**
 * Returns true if work1 is more work (greater than) work2
 */
export function isMoreWork(work1: string, work2: string): boolean {
  return validateWork(work1, 'work1').gt(validateWork(work2, 'work2'))
}

/**
 * Add two Buffer encoded chainwork values
 * @returns Sum of work1 + work2 as Buffer encoded chainWork value
 */
export function addWork(work1: string, work2: string): string {
  const sum = validateWork(work1, 'work1').add(validateWork(work2, 'work2'))
  return workBNtoBuffer(sum)
}

/**
 * Subtract Buffer encoded chainwork values
 * @returns work1 - work2 as Buffer encoded chainWork value
 */
export function subWork(work1: string, work2: string): string {
  const minuend = validateWork(work1, 'work1')
  const subtrahend = validateWork(work2, 'work2')
  if (minuend.lt(subtrahend)) throw new WERR_INVALID_PARAMETER('work1/work2', 'a non-negative subtraction')
  const sum = minuend.sub(subtrahend)
  return workBNtoBuffer(sum)
}

/**
 * Computes "target" value for 4 byte Bitcoin block header "bits" value.
 * @param bits number or converted from Buffer using `readUint32LE`
 * @returns 32 byte Buffer with "target" value
 */
export function convertBitsToTarget(bits: number | number[]): BigNumber {
  if (Array.isArray(bits)) {
    if (bits.length !== 4) throw new WERR_INVALID_PARAMETER('bits', 'exactly four bytes')
    validateByteWindow(bits, 0, 4, 'bits')
    bits = readUInt32LE(bits, 0)
  }
  validateUnsignedHeaderInteger(bits, 'bits', UINT32_MAX)

  const shift = (bits >> 24) & 0xff
  const data = bits & 0x007fffff

  const target = new BigNumber(data)
  if (shift <= 3) {
    target.iushrn(8 * (3 - shift))
  } else {
    target.iushln(8 * (shift - 3))
  }

  return target
}

function readCompactBits(bits: number[]): number {
  if (bits.length !== 4) throw new WERR_INVALID_PARAMETER('bits', 'exactly four bytes')
  validateByteWindow(bits, 0, 4, 'bits')
  return readUInt32LE(bits, 0)
}

/**
 * Computes "chainWork" value for 4 byte Bitcoin block header "bits" value.
 * @param bits number or converted from Buffer using `readUint32LE`
 * @param chain Optional chain the header belongs to. Selects its proof-of-work limit
 *   (see `proofOfWorkLimitBits`); omitted means the mainnet limit.
 * @returns 32 byte Buffer with "chainWork" value
 */
export function convertBitsToWork(bits: number | number[], chain?: Chain): string {
  const encoded = Array.isArray(bits) ? readCompactBits(bits) : bits
  const target = validateCompactTarget(encoded, chain)

  // convert target to work
  const work = target.notn(256).div(target.addn(1)).addn(1)

  return work.toString(16).padStart(64, '0')
}

export function deserializeBaseBlockHeaders(
  buffer: number[] | Uint8Array,
  offset = 0,
  count?: number | undefined
): BaseBlockHeader[] {
  if (!Array.isArray(buffer) && !(buffer instanceof Uint8Array)) {
    throw new WERR_INVALID_PARAMETER('buffer', 'a byte array')
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) {
    throw new WERR_INVALID_PARAMETER('offset', 'a non-negative safe integer within the buffer')
  }
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > MAX_HEADER_COUNT)) {
    throw new WERR_INVALID_PARAMETER('count', `an integer from 0 through ${MAX_HEADER_COUNT}`)
  }
  const available = Math.floor((buffer.length - offset) / 80)
  const limit = count ?? available
  if (Math.min(available, limit) > MAX_HEADER_COUNT) {
    throw new WERR_INVALID_PARAMETER('buffer', `no more than ${MAX_HEADER_COUNT} headers per decode`)
  }
  const headers: BaseBlockHeader[] = []
  while (headers.length < limit && offset + 80 <= buffer.length) {
    headers.push(deserializeBaseBlockHeader(buffer, offset))
    offset += 80
  }
  return headers
}

export function deserializeBlockHeaders(
  firstHeight: number,
  buffer: number[] | Uint8Array,
  offset = 0,
  count?: number | undefined
): BlockHeader[] {
  if (!Number.isSafeInteger(firstHeight) || firstHeight < 0 || firstHeight > MAX_BLOCK_HEIGHT) {
    throw new WERR_INVALID_PARAMETER('firstHeight', `an integer from 0 through ${MAX_BLOCK_HEIGHT}`)
  }
  const baseHeaders = deserializeBaseBlockHeaders(buffer, offset, count)
  if (firstHeight + baseHeaders.length - 1 > MAX_BLOCK_HEIGHT) {
    throw new WERR_INVALID_PARAMETER('headers', 'a range within the supported block heights')
  }
  const headers: BlockHeader[] = []
  let nextHeight = firstHeight
  while (headers.length < baseHeaders.length) {
    const baseBuffer = buffer.slice(offset, offset + 80)
    const base = baseHeaders[headers.length]
    const header = {
      ...base,
      height: nextHeight++,
      hash: asString(blockHash(baseBuffer))
    }
    headers.push(header)
    offset += 80
  }
  return headers
}

/**
 * Given a block header, ensures that its format is correct. This does not
 * check its difficulty or validity relative to the chain of headers.
 *
 * Throws on format errors.
 *
 * @param The header to validate
 *
 * @returns true if the header is correctly formatted
 */
function validateUnsignedHeaderInteger(value: unknown, field: string, maximum: number): void {
  if (typeof value !== 'number') {
    throw new TypeError(`Header ${field} must be a number.`)
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(`Header ${field} must be an integer.`)
  }
  if (value < 0 || value > maximum) {
    throw new Error(`Header ${field} must be between 0 and ${maximum}.`)
  }
}

const BASE_HEADER_KEYS = ['version', 'previousHash', 'merkleRoot', 'time', 'bits', 'nonce'] as const
const BLOCK_HEADER_KEYS = [...BASE_HEADER_KEYS, 'height', 'hash'] as const
function validateHeaderRecord(
  header: unknown,
  allowedKeys: readonly string[]
): asserts header is Record<string, unknown> {
  if (header == null) throw new TypeError('Missing header.')
  if (typeof header !== 'object' || Array.isArray(header)) {
    throw new TypeError('Header must be an object.')
  }
  const prototype = Object.getPrototypeOf(header)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Header must be a plain data object.')
  }
  const descriptors = Object.getOwnPropertyDescriptors(header)
  const keys = Object.keys(descriptors)
  if (
    keys.length !== allowedKeys.length ||
    !keys.every(key => allowedKeys.includes(key)) ||
    keys.some(key => descriptors[key]?.get != null || descriptors[key]?.set != null)
  ) {
    throw new Error('Header must contain exactly the required data properties.')
  }
}

/**
 * Validates the exact data representation of an unpositioned 80-byte block
 * header before it reaches a chain lookup, queue, or serializer.
 */
export function validateBaseBlockHeaderFormat(header: BaseBlockHeader): void {
  const UINT_MAX = 0xffffffff
  validateHeaderRecord(header, BASE_HEADER_KEYS)
  validateUnsignedHeaderInteger(header.version, 'version', UINT_MAX)
  if (typeof header.previousHash !== 'string' || !HEX_32_BYTES.test(header.previousHash)) {
    throw new Error('Header previousHash must be 32 hex bytes.')
  }
  if (typeof header.merkleRoot !== 'string' || !HEX_32_BYTES.test(header.merkleRoot)) {
    throw new Error('Header merkleRoot must be 32 hex bytes.')
  }
  validateUnsignedHeaderInteger(header.time, 'time', UINT_MAX)
  validateUnsignedHeaderInteger(header.bits, 'bits', UINT_MAX)
  validateUnsignedHeaderInteger(header.nonce, 'nonce', UINT_MAX)
}

export function validateHeaderFormat(header: BlockHeader): void {
  validateHeaderRecord(header, BLOCK_HEADER_KEYS)
  const baseHeader: BaseBlockHeader = {
    version: header.version,
    previousHash: header.previousHash,
    merkleRoot: header.merkleRoot,
    time: header.time,
    bits: header.bits,
    nonce: header.nonce
  }
  validateBaseBlockHeaderFormat(baseHeader)
  validateUnsignedHeaderInteger(header.height, 'height', 0x7fffffff)
  if (typeof header.hash !== 'string' || !HEX_32_BYTES.test(header.hash)) {
    throw new Error('Header hash must be 32 hex bytes.')
  }
  if (header.hash !== asString(blockHash(header))) {
    throw new Error('Header hash is invalid.')
  }
}

/**
 * Ensures that a header has a valid proof-of-work target and hash.
 *
 * @param hash The header hash, big-endian.
 * @param bits The header's compact target.
 * @param chain Optional chain the header belongs to. Selects its proof-of-work limit
 *   (see `proofOfWorkLimitBits`); omitted means the mainnet limit.
 *
 * @returns true if the header is valid
 */
export function validateHeaderDifficulty(hash: number[] | Uint8Array, bits: number, chain?: Chain) {
  if (!Array.isArray(hash) && !(hash instanceof Uint8Array)) {
    throw new WERR_INVALID_PARAMETER('hash', 'exactly 32 bytes')
  }
  validateByteWindow(hash, 0, hash.length, 'hash')
  if (hash.length !== 32) throw new WERR_INVALID_PARAMETER('hash', 'exactly 32 bytes')
  const hashBN = new BigNumber(asArray(hash))
  const target = validateCompactTarget(bits, chain)

  if (hashBN.lte(target)) return true

  throw new Error('Block hash is not less than specified target.')
}

const proofOfWorkExceptions = new Map([
  // The historical STN genesis header is a network-defined bootstrap
  // checkpoint whose hash does not satisfy its encoded target. No later
  // header receives this exception.
  ['6b38bdbcd73a19f7889d23e1fa6166a9de71affceca60ca3bb1b28af8135c594', 0x1d00ffff]
])

/** Compact encoding of the highest target (lowest difficulty) mainnet and every public test network admit. */
const MAINNET_POW_LIMIT_BITS = 0x1d00ffff

/**
 * Compact encoding of regtest's highest target, as Teranode defines it
 * (go-chaincfg `RegressionNetParams.PowLimitBits`). Every regtest header carries
 * these bits, so its proof of work costs nothing to produce: a regtest chain is
 * only as trustworthy as the ChainTracks service that serves it.
 */
const REGTEST_POW_LIMIT_BITS = 0x207fffff

/**
 * The compact encoding of the highest proof-of-work target `chain` admits.
 *
 * Only `'regtest'` raises the limit. Every other chain — and an omitted chain,
 * which is how every caller that predates this parameter asks — keeps the mainnet
 * limit, so no existing validation is relaxed.
 */
export function proofOfWorkLimitBits(chain?: Chain): number {
  return chain === 'regtest' ? REGTEST_POW_LIMIT_BITS : MAINNET_POW_LIMIT_BITS
}

function validateConsensusProofOfWork(hash: string, bits: number, chain?: Chain): void {
  if (proofOfWorkExceptions.get(hash) === bits) return
  validateHeaderDifficulty(asArray(hash, 'hex'), bits, chain)
}

function validateCompactTarget(bits: number, chain?: Chain): BigNumber {
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > 0xffffffff) {
    throw new Error('Block target encoding is invalid.')
  }
  const size = bits >>> 24
  const word = bits & 0x007fffff
  const negative = word !== 0 && (bits & 0x00800000) !== 0
  const overflow = word !== 0 && (size > 34 || (word > 0xff && size > 33) || (word > 0xffff && size > 32))
  if (word === 0 || negative || overflow) {
    throw new Error('Block target encoding is invalid.')
  }

  const target = convertBitsToTarget(bits)
  const proofOfWorkLimit = convertBitsToTarget(proofOfWorkLimitBits(chain))
  if (target.gt(proofOfWorkLimit)) {
    throw new Error('Block target exceeds the proof-of-work limit.')
  }
  return target
}

/**
 * Ensures that a structured header's computed hash satisfies its declared
 * proof-of-work target.
 *
 * @param header Header whose format and hash have already been checked.
 * @param chain Optional chain the header belongs to. Selects its proof-of-work limit
 *   (see `proofOfWorkLimitBits`); omitted means the mainnet limit.
 * @returns true if the header has valid proof-of-work.
 * @publicbody
 */
export function validateHeaderProofOfWork(header: BlockHeader, chain?: Chain): true {
  validateConsensusProofOfWork(header.hash, header.bits, chain)
  return true
}

/**
 * Computes double sha256 hash of bitcoin block header
 * bytes are reversed to bigendian order
 *
 * If header is a Buffer, it is required to 80 bytes long
 * and in standard block header serialized encoding.
 *
 * @returns doule sha256 hash of header bytes reversed
 * @publicbody
 */
export function blockHash(header: BaseBlockHeader | number[] | Uint8Array): string {
  const a = !Array.isArray(header) && !(header instanceof Uint8Array) ? serializeBaseBlockHeader(header) : header
  if (a.length !== 80) throw new Error('Block header must be 80 bytes long.')
  return asString(doubleSha256BE(a))
}

/**
 * Serializes a block header as an 80 byte Buffer.
 * The exact serialized format is defined in the Bitcoin White Paper
 * such that computing a double sha256 hash of the buffer computes
 * the block hash for the header.
 * @returns 80 byte Buffer
 * @publicbody
 */
export function serializeBaseBlockHeader(header: BaseBlockHeader, buffer?: number[], offset?: number): number[] {
  const validated = copyBaseHeaderData(header)
  validateBaseBlockHeaderFormat(validated)
  const writer = new Writer()
  writer.writeUInt32LE(validated.version)
  writer.write(asArray(validated.previousHash).reverse())
  writer.write(asArray(validated.merkleRoot).reverse())
  writer.writeUInt32LE(validated.time)
  writer.writeUInt32LE(validated.bits)
  writer.writeUInt32LE(validated.nonce)
  const data = writer.toArray()
  if (buffer != null) {
    if (!Array.isArray(buffer)) throw new WERR_INVALID_PARAMETER('buffer', 'an array')
    offset ??= 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + data.length > buffer.length) {
      throw new WERR_INVALID_PARAMETER('offset', 'a non-negative safe integer with 80 writable bytes')
    }
    for (let i = 0; i < data.length; i++) {
      buffer[offset + i] = data[i]
    }
  }
  return data
}

export function serializeBaseBlockHeaders(headers: BlockHeader[]): Uint8Array {
  if (!Array.isArray(headers) || headers.length > MAX_HEADER_COUNT) {
    throw new WERR_INVALID_PARAMETER('headers', `a dense array of no more than ${MAX_HEADER_COUNT} entries`)
  }
  const data = new Uint8Array(headers.length * 80)
  for (let index = 0; index < headers.length; index++) {
    if (!Object.hasOwn(headers, index)) throw new WERR_INVALID_PARAMETER('headers', 'a dense array')
    const d = serializeBaseBlockHeader(headers[index])
    data.set(d, index * 80)
  }
  return data
}

/**
 * Deserialize a BaseBlockHeader from an 80 byte buffer
 * @publicbody
 */
export function deserializeBaseBlockHeader(buffer: number[] | Uint8Array, offset = 0): BaseBlockHeader {
  validateByteWindow(buffer, offset, 80)
  const reader = ReaderUint8Array.makeReader(buffer, offset)
  const header: BaseBlockHeader = {
    version: reader.readUInt32LE(),
    previousHash: asString(reader.read(32).reverse()),
    merkleRoot: asString(reader.read(32).reverse()),
    time: reader.readUInt32LE(),
    bits: reader.readUInt32LE(),
    nonce: reader.readUInt32LE()
  }
  return header
}

export function deserializeBlockHeader(buffer: number[] | Uint8Array, height: number, offset = 0): BlockHeader {
  if (!Number.isSafeInteger(height) || height < 0 || height > MAX_BLOCK_HEIGHT) {
    throw new WERR_INVALID_PARAMETER('height', `an integer from 0 through ${MAX_BLOCK_HEIGHT}`)
  }
  const base = deserializeBaseBlockHeader(buffer, offset)
  const header: BlockHeader = {
    ...base,
    height,
    hash: asString(doubleSha256BE(buffer.slice(offset, offset + 80)))
  }
  return header
}

/**
 * Returns the genesis block for the specified chain.
 * @publicbody
 */
export function genesisHeader(chain: Chain): BlockHeader {
  switch (chain) {
    case 'main':
      return {
        version: 1,
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
        time: 1231006505,
        bits: 486604799,
        nonce: 2083236893,
        height: 0,
        hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
      }
    case 'test':
      return {
        version: 1,
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
        time: 1296688602,
        bits: 486604799,
        nonce: 414098458,
        height: 0,
        hash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
      }
    case 'stn':
      return {
        version: 1,
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
        time: 1296688602,
        bits: 486604799,
        nonce: 173779992,
        height: 0,
        // go-chaincfg v1.6.1 retains a stale StnParams.GenesisHash literal.
        // This is the hash of the serialized stnGenesisBlock header itself.
        hash: '6b38bdbcd73a19f7889d23e1fa6166a9de71affceca60ca3bb1b28af8135c594'
      }
    case 'ttn':
      return {
        version: 1,
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
        time: 1755606836,
        bits: 486604799,
        nonce: 1092578460,
        height: 0,
        hash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d'
      }
    case 'tstn':
      return {
        version: 1,
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        merkleRoot: '64452e5b25c65e492ad6a4f5ce9f427ca986626c28315d88de920d66e28cc98f',
        time: 1782864000,
        bits: 486604799,
        nonce: 1780488216,
        height: 0,
        hash: '000000005d221c0e023cb56b5682cf094f32cd959958b40bc931e5797cae706c'
      }
    case 'regtest':
      // go-chaincfg regTestGenesisBlock: the Bitcoin regtest genesis header.
      return {
        version: 1,
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
        time: 1296688602,
        bits: 545259519,
        nonce: 2,
        height: 0,
        hash: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
      }
    case 'mock':
      throw new Error("genesisHeader does not support 'mock' chain. Mock chain generates its own genesis block.")
  }
}

/**
 * Returns the genesis block for the specified chain.
 * @publicbody
 */
export function genesisBuffer(chain: Chain): number[] {
  return serializeBaseBlockHeader(genesisHeader(chain))
}

/**
 * Returns a copy of a Buffer with byte order reversed.
 * @returns new buffer with byte order reversed.
 * @publicbody
 */
export function swapByteOrder(buffer: number[]): number[] {
  return buffer.slice().reverse()
}

/**
 * @param num a number value in the Uint32 value range
 * @param littleEndian true for little-endian byte order in Buffer
 * @returns four byte buffer with Uint32 number encoded
 * @publicbody
 */
export function convertUint32ToBuffer(n: number, littleEndian = true): number[] {
  validateUnsignedHeaderInteger(n, 'uint32', UINT32_MAX)
  if (typeof littleEndian !== 'boolean') throw new WERR_INVALID_PARAMETER('littleEndian', 'a boolean')
  const a = [
    n & 0xff, // lowest byte
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >> 24) & 0xff // highest byte
  ]
  return littleEndian ? a : a.reverse()
}

export function writeUInt32LE(n: number, a: number[] | Uint8Array, offset: number): number {
  validateUnsignedHeaderInteger(n, 'uint32', UINT32_MAX)
  validateWritableByteWindow(a, offset, 4)
  a[offset++] = n & 0xff // lowest byte
  a[offset++] = (n >> 8) & 0xff
  a[offset++] = (n >> 16) & 0xff
  a[offset++] = (n >> 24) & 0xff // highest byte
  return offset
}

export function writeUInt32BE(n: number, a: number[] | Uint8Array, offset: number): number {
  validateUnsignedHeaderInteger(n, 'uint32', UINT32_MAX)
  validateWritableByteWindow(a, offset, 4)
  a[offset++] = (n >> 24) & 0xff // highest byte
  a[offset++] = (n >> 16) & 0xff
  a[offset++] = (n >> 8) & 0xff
  a[offset++] = n & 0xff // lowest byte
  return offset
}

export function readUInt32LE(a: number[] | Uint8Array, offset: number): number {
  validateByteWindow(a, offset, 4)
  return (a[offset++] | (a[offset++] << 8) | (a[offset++] << 16) | (a[offset++] << 24)) >>> 0
}

export function readUInt32BE(a: number[] | Uint8Array, offset: number): number {
  validateByteWindow(a, offset, 4)
  return ((a[offset++] << 24) | (a[offset++] << 16) | (a[offset++] << 8) | a[offset++]) >>> 0
}

/**
 * @param buffer four byte buffer with Uint32 number encoded
 * @param littleEndian true for little-endian byte order in Buffer
 * @returns a number value in the Uint32 value range
 * @publicbody
 */
export function convertBufferToUint32(buffer: number[] | Uint8Array, littleEndian = true): number {
  validateByteWindow(buffer, 0, 4)
  if (buffer.length !== 4) throw new WERR_INVALID_PARAMETER('buffer', 'exactly four bytes')
  if (typeof littleEndian !== 'boolean') throw new WERR_INVALID_PARAMETER('littleEndian', 'a boolean')
  const a = littleEndian ? buffer : buffer.slice().reverse()
  const n = (a[0] | (a[1] << 8) | (a[2] << 16) | (a[3] << 24)) >>> 0
  return n
}
