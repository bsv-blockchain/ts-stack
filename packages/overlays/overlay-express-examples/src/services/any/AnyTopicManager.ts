import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Signature, Transaction, PushDrop, Utils } from '@bsv/sdk'
import docs from './AnyTopicDocs.js'

/**
 * Topic manager for the simple "Any" messaging protocol.
 *
 * Each valid output must satisfy the following rules:
 * 1. There are no rules.
 */
export default class AnyTopicManager implements TopicManager {
  /**
   * Identify which outputs in the supplied transaction are admissible.
   *
   * @param beef          Raw transaction encoded in BEEF format.
   * @param previousCoins Previously‑retained coins (unused by this protocol).
   */
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

    // The Any protocol never retains previous coins
    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  /**
   * Get the documentation associated with this topic manager
   * @returns A promise that resolves to a string containing the documentation
   */
  async getDocumentation(): Promise<string> {
    return docs
  }

  /**
   * Get metadata about the topic manager
   * @returns A promise that resolves to an object containing metadata
   */
  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Any Topic Manager',
      shortDescription: "Any transaction is admitted by the Any Topic Manager."
    }
  }
}
