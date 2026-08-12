import { Hash } from '@bsv/sdk'
import { WERR_INVALID_PARAMETER } from '../../../../sdk'
import { asArray, asString } from '../../../../utility/utilityHelpers.noBuffer'
import type {
  BulkFileDataValidationRequest,
  BulkFileDataValidationResult,
  BulkFileDataValidatorApi
} from '../Api/BulkFileDataValidatorApi'
import { BulkFileDataValidationError } from '../Api/BulkFileDataValidatorApi'
import { validateBufferOfHeaders, validateGenesisHeader } from './blockHeaderUtilities'

/**
 * Portable complete-object validator. Node services should normally inject
 * `NodeBulkFileDataValidator`; browser and mobile consumers retain this
 * dependency-free fallback.
 *
 * @public
 */
export class InlineBulkFileDataValidator implements BulkFileDataValidatorApi {
  async validate(request: BulkFileDataValidationRequest): Promise<BulkFileDataValidationResult> {
    try {
      const expectedLength = request.count * 80
      if (request.data.length !== expectedLength) {
        throw new WERR_INVALID_PARAMETER(
          'file.data',
          `bulk file ${request.fileName} data length ${request.data.length} does not match expected count ${request.count}`
        )
      }

      const fileHash = asString(Hash.sha256(asArray(request.data)), 'base64')
      if (request.fileHash != null && fileHash !== request.fileHash) {
        throw new WERR_INVALID_PARAMETER('fileHash', `a match for retrieved data for ${request.fileName}`)
      }

      const { lastHeaderHash, lastChainWork } = validateBufferOfHeaders(
        request.data,
        request.prevHash,
        0,
        request.count,
        request.prevChainWork
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
      throw new BulkFileDataValidationError(message, request.data)
    }
  }
}
