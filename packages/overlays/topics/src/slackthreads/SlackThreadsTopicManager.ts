import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, OP } from '@bsv/sdk'

export default class SlackThreadsTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      for (const [index, output] of parsedTx.outputs.entries()) {
        try {
          if (output.lockingScript.chunks.length !== 3) throw new Error('Invalid locking script')
          if (output.lockingScript.chunks[0].op !== OP.OP_SHA256) throw new Error('Invalid locking script')
          if (output.lockingScript.chunks[1].op !== 32) throw new Error('Invalid locking script')
          if (output.lockingScript.chunks[2].op !== OP.OP_EQUAL) throw new Error('Invalid locking script')
          outputsToAdmit.push(index)
        } catch (err) {
          console.error(`Error processing output ${index}:`, err)
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('SlackThreads topic manager: no outputs admitted!')
      console.log(`Admitted ${outputsToAdmit.length} SlackThreads output(s)!`)
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
  }

  async getDocumentation(): Promise<string> {
    return 'SlackThreads Topic Manager: saves hashes of slack threads.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'SlackThreads Topic Manager',
      shortDescription: 'Saves hashes of slack threads'
    }
  }
}
