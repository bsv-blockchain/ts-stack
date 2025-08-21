import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { PushDrop, Transaction, Utils } from '@bsv/sdk'
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
    try {
      console.log('KVStore topic manager was invoked')
      const parsedTransaction = Transaction.fromBEEF(beef)

      // Validate params
      if (!Array.isArray(parsedTransaction.inputs) || parsedTransaction.inputs.length < 1) {
        throw new Error('Missing parameter: inputs')
      }
      if (!Array.isArray(parsedTransaction.outputs) || parsedTransaction.outputs.length < 1) {
        throw new Error('Missing parameter: outputs')
      }

      console.log('KVStore topic manager has parsed the transaction: ', parsedTransaction.id('hex'))

      // Try to decode and validate transaction outputs
      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          // Decode the KVStore fields from the Bitcoin outputScript
          const result = PushDrop.decode(output.lockingScript)

          // KVStore protocol validation
          // Expected structure: [protectedKey, value] in the PushDrop fields
          if (result.fields.length !== 2) {
            throw new Error('KVStore token must have exactly two PushDrop fields (protectedKey and value)')
          }

          // Validate the protected key (first field) - must be 32 bytes
          const protectedKeyBuffer = result.fields[0]
          if (protectedKeyBuffer.length !== 32) {
            throw new Error(`KVStore tokens have 32-byte protected keys, but this token has ${protectedKeyBuffer.length} bytes`)
          }

          // Validate the value field (second field) - must exist but can be any length
          const valueBuffer = result.fields[1]
          if (!valueBuffer || valueBuffer.length === 0) {
            throw new Error('KVStore tokens must have a non-empty value field')
          }

          console.log(
            `KVStore output ${i} validated:`,
            'protectedKey:', Utils.toBase64(protectedKeyBuffer).substring(0, 10) + '...',
            'valueLength:', valueBuffer.length
          )

          outputsToAdmit.push(i)
        } catch (error) {
          // It's common for other outputs to be invalid; no need to log an error here
          console.log(`Output ${i} not a valid KVStore token:`, (error as Error).message)
          continue
        }
      }

      if (outputsToAdmit.length === 0) {
        throw new Error('KVStore topic manager: no valid KVStore outputs found!')
      }

      // Returns an array of outputs admitted
      // And previousOutputsRetained (none by default for KVStore)
      return {
        outputsToAdmit,
        coinsToRetain: []
      }
    } catch (error) {
      // Only log an error if no outputs were admitted and no previous coins consumed
      if (outputsToAdmit.length === 0 && (previousCoins === undefined || previousCoins.length === 0)) {
        console.error('Error identifying admissible KVStore outputs:', error)
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

    return {
      outputsToAdmit,
      coinsToRetain: []
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
