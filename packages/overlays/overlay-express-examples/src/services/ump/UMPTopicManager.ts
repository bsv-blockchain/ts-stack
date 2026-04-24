import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop } from '@bsv/sdk'
import umpTopicDocs from './UMPTopicDocs.md.js'

/**
 * Implements a topic manager for User Management Protocol
 * @public
 */
export default class UMPTopicManager implements TopicManager {
  identifyNeededInputs?: ((beef: number[]) => Promise<Array<{ txid: string; outputIndex: number }>>) | undefined
  async getDocumentation(): Promise<string> {
    return umpTopicDocs
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string; iconURL?: string; version?: string; informationURL?: string }> {
    return {
      name: 'User Management Protocol',
      shortDescription: 'Manages CWI-style wallet account descriptors.'
    }
  }

  /**
   * Returns the outputs from the UMP transaction that are admissible.
   */
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    try {
      console.log('previous UTXOs', previousCoins.length)
      const outputs: number[] = []
      const parsedTransaction = Transaction.fromBEEF(beef)
      const previousUTXOs = previousCoins.map(x => ({
        txid: (parsedTransaction.inputs[x].sourceTXID || parsedTransaction.inputs[x].sourceTransaction?.id('hex')) as string,
        outputIndex: parsedTransaction.inputs[x].sourceOutputIndex
      }))

      // Try to decode and validate transaction outputs
      for (const [i, output] of parsedTransaction.outputs.entries()) {
        // Decode the UMP account fields
        try {
          const result = PushDrop.decode(output.lockingScript)
          if (result.fields.length < 11) { // UMP tokens have 11 fields
            throw new Error('Invalid UMP token')
          }
          outputs.push(i)
        } catch (error) {
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