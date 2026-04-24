import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction } from '@bsv/sdk'

/**
 * Topic manager for the simple "Any" messaging protocol.
 * Each valid output must satisfy the following rules:
 * 1. There are no rules.
 */
export default class AnyTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      console.log('Any topic manager invoked')
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      // Admit all outputs
      outputsToAdmit.push(...Array.from({ length: parsedTx.outputs.length }, (_, i) => i))
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  async getDocumentation(): Promise<string> {
    return 'Any Topic Manager: admits all transaction outputs.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Any Topic Manager',
      shortDescription: 'Any transaction is admitted by the Any Topic Manager.'
    }
  }
}
