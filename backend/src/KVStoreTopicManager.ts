import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { PushDrop, Transaction } from '@bsv/sdk'
import docs from './docs/KVStoreTopicManagerDocs.md.js'

/**
 * Implements a topic manager for KVStore tokens
 * @public
 */
export default class KVStoreTopicManager implements TopicManager {
  /**
   * Returns the outputs from the KVStore transaction that are admissible.
   * @param beef - The transaction data in BEEF format
   * @param previousCoins - The previous coins to consider
   * @returns A promise that resolves with the admittance instructions
   */
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    const parsedTransaction = Transaction.fromBEEF(beef)

    if (!Array.isArray(parsedTransaction.inputs) || parsedTransaction.inputs.length < 1) {
      throw new Error('Missing parameter: inputs')
    }
    if (!Array.isArray(parsedTransaction.outputs) || parsedTransaction.outputs.length < 1) {
      throw new Error('Missing parameter: outputs')
    }

    for (const [i, output] of parsedTransaction.outputs.entries()) {
      try {
        const result = PushDrop.decode(output.lockingScript)

        if (result.fields.length !== 3) {
          continue
        }

        const protectedKeyBuffer = result.fields[0]
        if (protectedKeyBuffer.length !== 32) {
          continue
        }

        const valueBuffer = result.fields[1]
        if (!valueBuffer || valueBuffer.length === 0) {
          continue
        }

        outputsToAdmit.push(i)
      } catch (error) {
        continue
      }
    }

    if (outputsToAdmit.length > 0) {
      console.log(`Admitted ${outputsToAdmit.length} KVStore ${outputsToAdmit.length === 1 ? 'output' : 'outputs'}!`)
    }

    if (previousCoins !== undefined && previousCoins.length > 0) {
      console.log(`Consumed ${previousCoins.length} previous KVStore ${previousCoins.length === 1 ? 'coin' : 'coins'}!`)
    }

    if (outputsToAdmit.length === 0 && (previousCoins === undefined || previousCoins.length === 0)) {
      console.warn('No KVStore outputs admitted, and no previous KVStore coins were consumed.')
    }

    console.log(`🔗 Retaining ${previousCoins?.length || 0} previous coins for history tracking`)
    return {
      outputsToAdmit,
      coinsToRetain: previousCoins || []
    }
  }

  /**
   * Get the documentation associated with this KVStore topic manager
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
      name: 'KVStore Topic Manager',
      shortDescription: 'Admits PushDrop tokens representing KVStore key-value pairs into an overlay.',
      version: '0.1.0',
    }
  }
}
