import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction } from '@bsv/sdk'
import SLAPTopicDocs from './SLAPTopic.docs.js'
import { isAdmissibleDiscoveryOutput } from '../utils/isAdmissibleDiscoveryOutput.js'
import {
  logDiscoveryIdentificationError,
  logDiscoverySummary
} from '../utils/discoveryTopicLogging.js'

/**
 * 🤚 SLAP Topic Manager
 * Implements the TopicManager interface for SLAP (Service Lookup Availability Protocol) tokens.
 *
 * The SLAP Topic Manager identifies admissible outputs based on SLAP protocol requirements.
 * SLAP tokens facilitate the advertisement of lookup services availability within the overlay network.
 */
export class SLAPTopicManager implements TopicManager {
  /**
   * Identifies admissible outputs for SLAP tokens.
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
          if (await isAdmissibleDiscoveryOutput(output.lockingScript, 'SLAP'))
            outputsToAdmit.push(i)
        } catch {
          // It's common for other outputs to be invalid SLAP advertisements; skip silently
        }
      }
    } catch (error) {
      // Only log an error if no outputs were admitted and no previous coins consumed
      logDiscoveryIdentificationError('SLAP', outputsToAdmit, previousCoins, error)
    }

    logDiscoverySummary('SLAP', outputsToAdmit, previousCoins)

    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  /**
   * Returns documentation specific to the SLAP topic manager.
   * @returns A promise that resolves to the documentation string.
   */
  async getDocumentation(): Promise<string> {
    return SLAPTopicDocs
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
      name: 'SLAP Topic Manager',
      shortDescription: 'Manages SLAP tokens for service lookup availability.'
    }
  }
}
