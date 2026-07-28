import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction } from '@bsv/sdk'
import SHIPTopicDocs from './SHIPTopic.docs.js'
import { isAdmissibleDiscoveryOutput } from '../utils/isAdmissibleDiscoveryOutput.js'
import {
  logDiscoveryIdentificationError,
  logDiscoverySummary
} from '../utils/discoveryTopicLogging.js'

/**
 * 🚢 SHIP Topic Manager
 * Implements the TopicManager interface for SHIP (Service Host Interconnect Protocol) tokens.
 *
 * The SHIP Topic Manager identifies admissible outputs based on SHIP protocol requirements.
 * SHIP tokens facilitate the advertisement of nodes hosting specific topics within the overlay network.
 */
export class SHIPTopicManager implements TopicManager {
  /**
   * Identifies admissible outputs for SHIP tokens.
   * @param beef - The transaction data in BEEF format.
   * @param previousCoins - The previous coins to consider.
   * @returns A promise that resolves with the admittance instructions.
   */
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    try {
      const parsedTransaction = Transaction.fromBEEF(beef)

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          if (await isAdmissibleDiscoveryOutput(output.lockingScript, 'SHIP'))
            outputsToAdmit.push(i)
        } catch {
          // It's common for other outputs to be invalid SHIP advertisements; skip silently
        }
      }
    } catch (error) {
      // Only log an error if no outputs were admitted and no previous coins consumed
      logDiscoveryIdentificationError('SHIP', outputsToAdmit, previousCoins, error)
    }

    logDiscoverySummary('SHIP', outputsToAdmit, previousCoins)

    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  /**
   * Returns documentation specific to the SHIP topic manager.
   * @returns A promise that resolves to the documentation string.
   */
  async getDocumentation(): Promise<string> {
    return SHIPTopicDocs
  }

  /**
   * Returns metadata associated with this topic manager.
   * @returns A promise that resolves to an object containing metadata.
   */
  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'SHIP Topic Manager',
      shortDescription: 'Manages SHIP tokens for service host interconnect.'
    }
  }
}
