import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Signature, Transaction, PushDrop, Utils, OP } from '@bsv/sdk'
import docs from './DesktopIntegrityTopicDocs.js'

export default class DesktopIntegrityTopicManager implements TopicManager {
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
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      // Inspect every output
      for (const [index, output] of parsedTx.outputs.entries()) {
        try {
          if (output.lockingScript.chunks.length !== 2) throw new Error('Invalid locking script')
          if (output.lockingScript.chunks[0].op !== OP.OP_FALSE) throw new Error('Invalid locking script')
          if (output.lockingScript.chunks[1].op !== OP.OP_RETURN) throw new Error('Invalid locking script')

          outputsToAdmit.push(index)
        } catch (err) {
          console.error(`Error processing output ${index}:`, err)
          // Continue with next output
        }
      }

      if (outputsToAdmit.length === 0) {
        throw new Error('DesktopIntegrity topic manager: no outputs admitted!')
      }

      console.log(`Admitted ${outputsToAdmit.length} DesktopIntegrity ${outputsToAdmit.length === 1 ? 'output' : 'outputs'}!`)
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    // The DesktopIntegrity protocol never retains previous coins
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
      name: 'DesktopIntegrity Topic Manager',
      shortDescription: "Saves hashes of files and integrity off-chain values"
    }
  }
}
