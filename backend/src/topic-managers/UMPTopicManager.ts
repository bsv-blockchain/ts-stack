import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop } from '@bsv/sdk'
import umpTopicDocs from './UMPTopicDocs.md.js'

/**
 * Implements a topic manager for User Management Protocol
 * @public
 */
export default class UMPTopicManager implements TopicManager {
  identifyNeededInputs?: ((beef: number[]) => Promise<Array<{ txid: string; outputIndex: number }>>) | undefined
  async getDocumentation(): Promise<string> {
    return umpTopicDocs
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string; iconURL?: string; version?: string; informationURL?: string }> {
    return {
      name: 'User Management Protocol',
      shortDescription: 'Manages CWI-style wallet account descriptors.'
    }
  }

  /**
   * Returns the outputs from the UMP transaction that are admissible.
   * Validates both legacy tokens and v3 tokens with KDF metadata.
   */
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    try {
      const outputs: number[] = []
      const parsedTransaction = Transaction.fromBEEF(beef)

      // Try to decode and validate transaction outputs
      for (const [i, output] of parsedTransaction.outputs.entries()) {
        // Decode the UMP account fields
        try {
          const result = PushDrop.decode(output.lockingScript)

          // Parse protocol fields (excluding trailing signature)
          const protocolFields = result.fields

          // Minimum fields check: need at least 11 core fields
          if (protocolFields.length < 11) {
            throw new Error('Invalid UMP token: insufficient fields')
          }

          // Detect v3 token: umpVersion is a single byte at field[11] (no profiles)
          // or field[12] (with profiles). Multi-byte fields[11] means profiles present.
          const hasV3AtIndex11 = protocolFields.length >= 12 && protocolFields[11]?.length === 1
          const hasV3AtIndex12 = !hasV3AtIndex11 && protocolFields.length >= 13 && protocolFields[12]?.length === 1
          const hasV3Candidate = hasV3AtIndex11 || hasV3AtIndex12
          const v3VersionIndex = hasV3AtIndex12 ? 12 : 11

          // If v3 token detected, validate KDF metadata
          if (hasV3Candidate) {
            // Validate umpVersion
            if (protocolFields[v3VersionIndex][0] !== 3) {
              throw new Error('Invalid UMP v3 token: umpVersion must be 3')
            }

            const kdfAlgIndex = v3VersionIndex + 1
            const kdfParamsIndex = v3VersionIndex + 2

            // Validate kdfAlgorithm field exists and is valid UTF-8
            if (!protocolFields[kdfAlgIndex] || protocolFields[kdfAlgIndex].length === 0) {
              throw new Error('Invalid UMP v3 token: missing kdfAlgorithm')
            }
            const kdfAlgorithm = new TextDecoder().decode(new Uint8Array(protocolFields[kdfAlgIndex]))
            if (kdfAlgorithm !== 'argon2id' && kdfAlgorithm !== 'pbkdf2-sha512') {
              throw new Error(`Invalid UMP v3 token: unsupported kdfAlgorithm "${kdfAlgorithm}"`)
            }

            // Validate kdfParams field exists and is valid JSON
            if (!protocolFields[kdfParamsIndex] || protocolFields[kdfParamsIndex].length === 0) {
              throw new Error('Invalid UMP v3 token: missing kdfParams')
            }
            const kdfParamsJson = new TextDecoder().decode(new Uint8Array(protocolFields[kdfParamsIndex]))
            try {
              const kdfParams = JSON.parse(kdfParamsJson)
              if (!kdfParams.iterations || kdfParams.iterations <= 0) {
                throw new Error('Invalid UMP v3 token: kdfParams.iterations must be positive')
              }
            } catch (e) {
              throw new Error(`Invalid UMP v3 token: malformed kdfParams JSON - ${(e as Error).message}`)
            }
          }

          // Token is valid (legacy or v3)
          outputs.push(i)
        } catch (error) {
          console.warn(`Output ${i} failed UMP validation:`, error)
        }
      }

      if (outputs.length === 0) {
        throw new Error(
          'This transaction does not publish a valid CWI account descriptor!'
        )
      }

      // Returns an array of output numbers
      return {
        coinsToRetain: previousCoins,
        outputsToAdmit: outputs
      }
    } catch (error) {
      return {
        coinsToRetain: [],
        outputsToAdmit: []
      }
    }
  }
}