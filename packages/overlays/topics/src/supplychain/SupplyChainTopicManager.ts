import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, OP } from '@bsv/sdk'

export default class SupplyChainTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      for (const [index, output] of parsedTx.outputs.entries()) {
        try {
          if (output.lockingScript.chunks.length !== 5) throw new Error('Invalid locking script error 1')
          if (output.lockingScript.chunks[0].op <= 0) throw new Error('Invalid locking script error 2')
          if (output.lockingScript.chunks[1].op <= 0) throw new Error('Invalid locking script error 3')
          if (output.lockingScript.chunks[2].op !== OP.OP_2DROP) throw new Error('Invalid locking script error 4')
          if (output.lockingScript.chunks[3].op !== 33) throw new Error('Invalid locking script error 5')
          if (output.lockingScript.chunks[4].op !== OP.OP_CHECKSIG) throw new Error('Invalid locking script error 6')
          outputsToAdmit.push(index)
        } catch (err) {
          console.error(`Error processing output ${index}:`, err)
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('SupplyChain topic manager: no outputs admitted!')
      console.log(`Admitted ${outputsToAdmit.length} SupplyChain output(s)!`)
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    return { outputsToAdmit, coinsToRetain: previousCoins }
  }

  async getDocumentation(): Promise<string> {
    return 'SupplyChain Topic Manager: saves hashes of files and integrity off-chain values.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'SupplyChain Topic Manager',
      shortDescription: 'Saves hashes of files and integrity off-chain values'
    }
  }
}
