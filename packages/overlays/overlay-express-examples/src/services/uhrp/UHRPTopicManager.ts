import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop, Utils } from '@bsv/sdk'
import uhrpTopicDocs from './UHRPTopicDocs.md.js'
import { isTokenSignatureCorrectlyLinked } from './isTokenSignatureCorrectlyLinked.js';

/**
 * Implements a topic manager for Universal Hash Resolution Protocol
 * @public
 */
export default class UHRPTopicManager implements TopicManager {
  identifyNeededInputs?: ((beef: number[]) => Promise<Array<{ txid: string; outputIndex: number }>>) | undefined
  async getDocumentation(): Promise<string> {
    return uhrpTopicDocs
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string; iconURL?: string; version?: string; informationURL?: string }> {
    return {
      name: 'Universal Hash Resolution Protocol',
      shortDescription: 'Manages UHRP content availability advertisements.'
    }
  }

  /**
   * Returns the outputs from the UHRP transaction that are admissible.
   */
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    try {
      console.log('previous UTXOs', previousCoins.length)
      const outputs: number[] = []
      const parsedTransaction = Transaction.fromBEEF(beef)

      // Try to decode and validate transaction outputs
      for (const [i, output] of parsedTransaction.outputs.entries()) {
        // Decode the UHRP account fields
        try {
          const result = PushDrop.decode(output.lockingScript)
          if (result.fields.length < 5) { // UHRP tokens have 5 fields
            throw new Error('Invalid UHRP token')
          }
          // Check key linages
          const isLinked = await isTokenSignatureCorrectlyLinked(result.lockingPublicKey, result.fields)
          if (!isLinked) {
            throw new Error('Signature is not properly linked')
          }
          if (result.fields[1].length !== 32) {
            throw new Error('Invalid hash length')
          }
          const fileLocationString = Utils.toUTF8(result.fields[2])
          const fileLocationURL = new URL(fileLocationString)
          if (fileLocationURL.protocol !== 'https:') {
            throw new Error('Advertisement must be on HTTPS')
          }
          const expiryTime = new Utils.Reader(result.fields[3]).readVarIntNum()
          const fileSize = new Utils.Reader(result.fields[4]).readVarIntNum()
          if (expiryTime < 1 || fileSize < 1) {
            throw new Error('Invalid expiry time or file size')
          }
          outputs.push(i)
        } catch (error) {
          console.error('Error with output', i, error)
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