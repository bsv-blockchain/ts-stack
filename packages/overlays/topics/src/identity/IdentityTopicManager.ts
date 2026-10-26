import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { ProtoWallet, Transaction } from '@bsv/sdk'
import { validateIdentityOutput } from './identityTokenValidation.js'

export default class IdentityTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    try {
      console.log('Identity topic manager was invoked')
      const parsedTransaction = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTransaction.inputs) || parsedTransaction.inputs.length < 1)
        throw new Error('Missing parameter: inputs')
      if (!Array.isArray(parsedTransaction.outputs) || parsedTransaction.outputs.length < 1)
        throw new Error('Missing parameter: outputs')

      const anyoneWallet = new ProtoWallet('anyone')

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          await validateIdentityOutput(output, anyoneWallet)
          outputsToAdmit.push(i)
        } catch (error) {
          console.error(`Error parsing output ${i}`, error)
          continue
        }
      }

      if (outputsToAdmit.length === 0)
        throw new Error('Identity topic manager: no outputs admitted!')

      return { outputsToAdmit, coinsToRetain: [] }
    } catch (error) {
      if (
        outputsToAdmit.length === 0 &&
        (previousCoins === undefined || previousCoins.length === 0)
      ) {
        console.error('Error identifying admissible outputs:', error)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
  }

  async getDocumentation(): Promise<string> {
    return 'Identity Topic Manager: register verifiable identity certificates for public discovery.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Identity Topic Manager',
      shortDescription: 'Identity Resolution Protocol'
    }
  }
}
