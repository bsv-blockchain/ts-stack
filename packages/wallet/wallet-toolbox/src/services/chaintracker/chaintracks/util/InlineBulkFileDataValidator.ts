import { sha256 } from '@bsv/sdk/primitives/Hash'
import { WERR_INVALID_PARAMETER } from '../../../../sdk'
import { asArray, asString } from '../../../../utility/utilityHelpers.noBuffer'
import type {
  BulkFileDataValidationRequest,
  BulkFileDataValidationResult,
  BulkFileDataValidatorApi
} from '../Api/BulkFileDataValidatorApi'
import { BulkFileDataValidationError } from '../Api/BulkFileDataValidatorApi'
import { validateBufferOfHeaders, validateGenesisHeader } from './blockHeaderUtilities'

const MAX_HEADERS_PER_FILE = 100_000
const HEX_32_BYTES = /^[0-9a-f]{64}$/
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/
const SUPPORTED_CHAINS = new Set(['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'])

function canonicalSha256(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false
  try {
    const bytes = asArray(value, 'base64')
    return bytes.length === 32 && asString(bytes, 'base64') === value
  } catch {
    return false
  }
}

/** Normalize and snapshot a complete validator request before asynchronous work. */
export function normalizeBulkFileDataValidationRequest(request: unknown): BulkFileDataValidationRequest {
  if (request == null || typeof request !== 'object' || Array.isArray(request)) {
    throw new WERR_INVALID_PARAMETER('validation request', 'a plain data object')
  }
  const prototype = Object.getPrototypeOf(request)
  const descriptors = Object.getOwnPropertyDescriptors(request)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    throw new WERR_INVALID_PARAMETER('validation request', 'an accessor-free plain data object')
  }
  const own = (name: string, required = true): unknown => {
    const descriptor = descriptors[name]
    if (descriptor == null) {
      if (!required) return undefined
      throw new WERR_INVALID_PARAMETER('validation request', `an own ${name} data property`)
    }
    return 'value' in descriptor ? descriptor.value : undefined
  }
  const data = own('data')
  const count = own('count')
  const firstHeight = own('firstHeight')
  const fileName = own('fileName')
  const fileHash = own('fileHash', false)
  const prevHash = own('prevHash')
  const prevChainWork = own('prevChainWork')
  const lastHash = own('lastHash', false)
  const lastChainWork = own('lastChainWork', false)
  const chain = own('chain', false)

  if (!(data instanceof Uint8Array)) throw new WERR_INVALID_PARAMETER('request.data', 'a Uint8Array')
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > MAX_HEADERS_PER_FILE) {
    throw new WERR_INVALID_PARAMETER('request.count', `an integer from 1 through ${MAX_HEADERS_PER_FILE}`)
  }
  if (data.byteLength !== (count as number) * 80) {
    throw new WERR_INVALID_PARAMETER('request.data', 'exactly count times 80 bytes')
  }
  if (
    !Number.isSafeInteger(firstHeight) ||
    (firstHeight as number) < 0 ||
    (firstHeight as number) + (count as number) - 1 > 0x7fffffff
  ) {
    throw new WERR_INVALID_PARAMETER('request.firstHeight', 'a supported block-header range')
  }
  if (typeof fileName !== 'string' || !SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
    throw new WERR_INVALID_PARAMETER('request.fileName', 'a safe path-free ASCII file name')
  }
  if (fileHash !== undefined && !canonicalSha256(fileHash)) {
    throw new WERR_INVALID_PARAMETER('request.fileHash', 'a canonical base64 SHA-256 digest when defined')
  }
  for (const [name, value, optional] of [
    ['prevHash', prevHash, false],
    ['prevChainWork', prevChainWork, false],
    ['lastHash', lastHash, true],
    ['lastChainWork', lastChainWork, true]
  ] as const) {
    if ((value === undefined || value === null) && optional) continue
    if (typeof value !== 'string' || !HEX_32_BYTES.test(value)) {
      throw new WERR_INVALID_PARAMETER(`request.${name}`, 'exactly 32 lowercase hexadecimal bytes')
    }
  }
  if (chain !== undefined && (typeof chain !== 'string' || !SUPPORTED_CHAINS.has(chain))) {
    throw new WERR_INVALID_PARAMETER('request.chain', 'a supported Chaintracks network when defined')
  }

  return {
    fileName,
    data: data.slice(),
    count: count as number,
    fileHash: fileHash as string | undefined,
    firstHeight: firstHeight as number,
    prevHash: prevHash as string,
    prevChainWork: prevChainWork as string,
    lastHash: lastHash as string | null | undefined,
    lastChainWork: lastChainWork as string | null | undefined,
    chain: chain as BulkFileDataValidationRequest['chain']
  }
}

/**
 * Portable complete-object validator. Node services should normally inject
 * `NodeBulkFileDataValidator`; browser and mobile consumers retain this
 * dependency-free fallback.
 *
 * @public
 */
export class InlineBulkFileDataValidator implements BulkFileDataValidatorApi {
  async validate(request: BulkFileDataValidationRequest): Promise<BulkFileDataValidationResult> {
    let rejectedData: Uint8Array | undefined
    try {
      request = normalizeBulkFileDataValidationRequest(request)
      rejectedData = request.data
      const expectedLength = request.count * 80
      if (request.data.length !== expectedLength) {
        throw new WERR_INVALID_PARAMETER(
          'file.data',
          `bulk file ${request.fileName} data length ${request.data.length} does not match expected count ${request.count}`
        )
      }

      const fileHash = asString(sha256(asArray(request.data)), 'base64')
      if (request.fileHash != null && fileHash !== request.fileHash) {
        throw new WERR_INVALID_PARAMETER('fileHash', `a match for retrieved data for ${request.fileName}`)
      }

      const { lastHeaderHash, lastChainWork } = validateBufferOfHeaders(
        request.data,
        request.prevHash,
        0,
        request.count,
        request.prevChainWork,
        request.chain ?? undefined
      )

      if (request.lastHash && request.lastHash !== lastHeaderHash) {
        throw new WERR_INVALID_PARAMETER('file.lastHash', `expected ${request.lastHash} but got ${lastHeaderHash}`)
      }
      if (request.lastChainWork && request.lastChainWork !== lastChainWork) {
        throw new WERR_INVALID_PARAMETER(
          'file.lastChainWork',
          `expected ${request.lastChainWork} but got ${lastChainWork}`
        )
      }
      if (request.firstHeight === 0 && request.chain != null) validateGenesisHeader(request.data, request.chain)

      return {
        data: request.data,
        fileHash,
        lastHeaderHash,
        lastChainWork: lastChainWork!
      }
    } catch (error) {
      if (error instanceof BulkFileDataValidationError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new BulkFileDataValidationError(message.slice(0, 4096), rejectedData)
    }
  }
}
