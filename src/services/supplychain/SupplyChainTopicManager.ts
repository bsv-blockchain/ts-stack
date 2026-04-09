import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, OP } from '@bsv/sdk'
import docs from './SupplyChainTopicDocs.js'

export default class SupplyChainTopicManager implements TopicManager {
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
        // For pushdata chunks we simply check <= 0 because they differ depending on the data
        try {
          if (output.lockingScript.chunks.length !== 5) throw new Error('Invalid locking script error 1') // Pushdrop script has length of 5
          if (output.lockingScript.chunks[0].op <= 0) throw new Error('Invalid locking script error 2') // Pushdrop metadata
          if (output.lockingScript.chunks[1].op <= 0) throw new Error('Invalid locking script error 3')
          if (output.lockingScript.chunks[2].op !== OP.OP_2DROP) throw new Error('Invalid locking script error 4')
          if (output.lockingScript.chunks[3].op !== 33) throw new Error('Invalid locking script error 5') // Public key hash
          if (output.lockingScript.chunks[4].op !== OP.OP_CHECKSIG) throw new Error('Invalid locking script error 6')

          outputsToAdmit.push(index)
        } catch (err) {
          console.error(`Error processing output ${index}:`, err)
          // Continue with next output
        }
      }

      if (outputsToAdmit.length === 0) {
        throw new Error('SupplyChain topic manager: no outputs admitted!')
      }

      console.log(`Admitted ${outputsToAdmit.length} SupplyChain ${outputsToAdmit.length === 1 ? 'output' : 'outputs'}!`)
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    // The SupplyChain protocol never retains previous coins
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
      name: 'SupplyChain Topic Manager',
      shortDescription: "Saves hashes of files and integrity off-chain values"
    }
  }
}
