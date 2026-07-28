import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop } from '@bsv/sdk'

function getV3VersionIndex(protocolFields: number[][]): number | undefined {
  const hasV3AtIndex11 = protocolFields.length >= 12 && protocolFields[11]?.length === 1
  if (hasV3AtIndex11) return 11
  const hasV3AtIndex12 = protocolFields.length >= 13 && protocolFields[12]?.length === 1
  return hasV3AtIndex12 ? 12 : undefined
}

function parseKdfParams(field: number[] | undefined): void {
  if (field === undefined || field.length === 0) {
    throw new Error('Invalid UMP v3 token: missing kdfParams')
  }
  const kdfParamsJson = new TextDecoder().decode(new Uint8Array(field))
  try {
    const kdfParams = JSON.parse(kdfParamsJson)
    if (!kdfParams.iterations || kdfParams.iterations <= 0) {
      throw new Error('Invalid UMP v3 token: kdfParams.iterations must be positive')
    }
  } catch (error) {
    throw new Error(`Invalid UMP v3 token: malformed kdfParams JSON - ${(error as Error).message}`)
  }
}

function validateV3Fields(protocolFields: number[][], versionIndex: number): void {
  if (protocolFields[versionIndex][0] !== 3) {
    throw new Error('Invalid UMP v3 token: umpVersion must be 3')
  }

  const kdfAlgorithmField = protocolFields[versionIndex + 1]
  if (kdfAlgorithmField === undefined || kdfAlgorithmField.length === 0) {
    throw new Error('Invalid UMP v3 token: missing kdfAlgorithm')
  }
  const kdfAlgorithm = new TextDecoder().decode(new Uint8Array(kdfAlgorithmField))
  if (kdfAlgorithm !== 'argon2id' && kdfAlgorithm !== 'pbkdf2-sha512') {
    throw new Error(`Invalid UMP v3 token: unsupported kdfAlgorithm "${kdfAlgorithm}"`)
  }
  parseKdfParams(protocolFields[versionIndex + 2])
}

function validateUMPFields(protocolFields: number[][]): void {
  if (protocolFields.length < 11) {
    throw new Error('Invalid UMP token: insufficient fields')
  }
  const versionIndex = getV3VersionIndex(protocolFields)
  if (versionIndex !== undefined) validateV3Fields(protocolFields, versionIndex)
}

export default class UMPTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    try {
      const outputs: number[] = []
      const parsedTransaction = Transaction.fromBEEF(beef)

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          const result = PushDrop.decode(output.lockingScript)
          const protocolFields = result.fields
          validateUMPFields(protocolFields)
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
