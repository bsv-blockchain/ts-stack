import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop, Utils } from '@bsv/sdk'
import { isTokenSignatureCorrectlyLinked } from '../utils/isTokenSignatureCorrectlyLinked.js'
import { isAdvertisableURI } from '../utils/isAdvertisableURI.js'
import SHIPTopicDocs from './SHIPTopic.docs.js'
import { isValidTopicOrServiceName } from '../utils/isValidTopicOrServiceName.js'

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
  async identifyAdmissibleOutputs (beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    try {
      const parsedTransaction = Transaction.fromBEEF(beef)

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          const result = PushDrop.decode(output.lockingScript)
          if (result.fields.length !== 5) continue // SHIP tokens have 5 fields

          const shipIdentifier = Utils.toUTF8(result.fields[0])
          if (shipIdentifier !== 'SHIP') continue // SHIP identifier must be present

          const advertisedURI = Utils.toUTF8(result.fields[2])
          if (!isAdvertisableURI(advertisedURI)) continue // Advertised URI must be acceptable

          const topic = Utils.toUTF8(result.fields[3])
          if (!isValidTopicOrServiceName(topic)) continue // Topic or service name must be valid
          if (!topic.startsWith('tm_')) continue // SHIP only accepts "tm_" (topic manager) advertisements
          if (!isTokenSignatureCorrectlyLinked(result.lockingPublicKey, result.fields)) continue // Signatures must be properly linked

          outputsToAdmit.push(i)
        } catch (error) {
          // It's common for other outputs to be invalid; no need to log an error here
          continue
        }
      }
    } catch (error) {
      // Only log an error if no outputs were admitted and no previous coins consumed
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('⛴️ Error identifying admissible outputs:', error)
      }
    }

    if (outputsToAdmit.length > 0) {
      console.log(`🛳️ Ahoy! Admitted ${outputsToAdmit.length} SHIP ${outputsToAdmit.length === 1 ? 'output' : 'outputs'}!`)
    }

    if (previousCoins && previousCoins.length > 0) {
      console.log(`🚢 Consumed ${previousCoins.length} previous SHIP ${previousCoins.length === 1 ? 'coin' : 'coins'}!`)
    }

    if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
      console.warn('⚓ No SHIP outputs admitted and no previous SHIP coins consumed.')
    }

    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  /**
   * Returns documentation specific to the SHIP topic manager.
   * @returns A promise that resolves to the documentation string.
   */
  async getDocumentation (): Promise<string> {
    return SHIPTopicDocs
  }

  /**
   * Returns metadata associated with this topic manager.
   * @returns A promise that resolves to an object containing metadata.
   */
  async getMetaData (): Promise<{
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
