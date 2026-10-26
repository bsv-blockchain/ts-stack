import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { decodeAndVerifyUHRPAdvertisement, Transaction } from '@bsv/sdk'

export default class UHRPTopicManager implements TopicManager {
  identifyNeededInputs?: (beef: number[]) => Promise<Array<{ txid: string, outputIndex: number }>>

  async getDocumentation (): Promise<string> {
    return 'Universal Hash Resolution Protocol: manages UHRP content availability advertisements.'
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string, iconURL?: string, version?: string, informationURL?: string }> {
    return {
      name: 'Universal Hash Resolution Protocol',
      shortDescription: 'Manages UHRP content availability advertisements.'
    }
  }

  async identifyAdmissibleOutputs (beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    try {
      console.log('previous UTXOs', previousCoins.length)
      const outputs: number[] = []
      const parsedTransaction = Transaction.fromBEEF(beef)

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          await decodeAndVerifyUHRPAdvertisement(output.lockingScript)
          outputs.push(i)
        } catch (error) {
          console.error('Error with output', i, error)
        }
      }

      if (outputs.length === 0) throw new Error('This transaction does not publish a valid UHRP advertisement')

      return { coinsToRetain: previousCoins, outputsToAdmit: outputs }
    } catch (error) {
      console.warn(`[UHRPTopicManager] identifyAdmissibleOutputs failed: ${error}`)
      return { coinsToRetain: [], outputsToAdmit: [] }
    }
  }
}
