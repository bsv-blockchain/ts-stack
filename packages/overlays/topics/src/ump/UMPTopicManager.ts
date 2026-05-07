import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop } from '@bsv/sdk'

export default class UMPTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    try {
      const outputs: number[] = []
      const parsedTransaction = Transaction.fromBEEF(beef)

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          const result = PushDrop.decode(output.lockingScript)
          const protocolFields = result.fields

          if (protocolFields.length < 11) {
            throw new Error('Invalid UMP token: insufficient fields')
          }

          // Detect v3 token
          const hasV3AtIndex11 = protocolFields.length >= 12 && protocolFields[11]?.length === 1
          const hasV3AtIndex12 = !hasV3AtIndex11 && protocolFields.length >= 13 && protocolFields[12]?.length === 1
          const hasV3Candidate = hasV3AtIndex11 || hasV3AtIndex12
          const v3VersionIndex = hasV3AtIndex12 ? 12 : 11

          if (hasV3Candidate) {
            if (protocolFields[v3VersionIndex][0] !== 3) {
              throw new Error('Invalid UMP v3 token: umpVersion must be 3')
            }

            const kdfAlgIndex = v3VersionIndex + 1
            const kdfParamsIndex = v3VersionIndex + 2

            if (!protocolFields[kdfAlgIndex] || protocolFields[kdfAlgIndex].length === 0) {
              throw new Error('Invalid UMP v3 token: missing kdfAlgorithm')
            }
            const kdfAlgorithm = new TextDecoder().decode(new Uint8Array(protocolFields[kdfAlgIndex]))
            if (kdfAlgorithm !== 'argon2id' && kdfAlgorithm !== 'pbkdf2-sha512') {
              throw new Error(`Invalid UMP v3 token: unsupported kdfAlgorithm "${kdfAlgorithm}"`)
            }

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

          outputs.push(i)
        } catch (error) {
          console.warn(`Output ${i} failed UMP validation:`, error)
        }
      }

      if (outputs.length === 0) {
        throw new Error('This transaction does not publish a valid CWI account descriptor!')
      }

      return { coinsToRetain: previousCoins, outputsToAdmit: outputs }
    } catch (error) {
      console.warn(`[UMPTopicManager] identifyAdmissibleOutputs failed: ${error}`)
      return { coinsToRetain: [], outputsToAdmit: [] }
    }
  }

  async getDocumentation(): Promise<string> {
    return 'UMP Topic Manager: manages CWI-style wallet account descriptors.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'User Management Protocol',
      shortDescription: 'Manages CWI-style wallet account descriptors.'
    }
  }
}
