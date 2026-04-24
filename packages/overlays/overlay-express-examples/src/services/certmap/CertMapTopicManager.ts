import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { KeyDeriver, ProtoWallet, PushDrop, Signature, Transaction, Utils } from '@bsv/sdk'
import docs from './CertMapTopicManagerDocs.md.js'

/**
 * Implements a topic manager for CertMap name registry
 * @public
 */
export default class CertMapTopicManager implements TopicManager {
  /**
   * Returns the outputs from the CertMap transaction that are admissible.
   * @param beef - The transaction data in BEEF format
   * @param previousCoins - The previous coins to consider
   * @returns A promise that resolves with the admittance instructions
   */
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    try {
      const parsedTransaction = Transaction.fromBEEF(beef)

      // Validate params
      if (!Array.isArray(parsedTransaction.inputs) || parsedTransaction.inputs.length < 1) {
        throw new Error('Transaction inputs must be valid')
      }
      if (!Array.isArray(parsedTransaction.outputs) || parsedTransaction.outputs.length < 1) {
        throw new Error('Transaction outputs must be valid')
      }
      // Try to decode and validate transaction outputs
      for (const [i, output] of parsedTransaction.outputs.entries()) {
        // Decode the CertMap registration data
        try {
          const { fields, lockingPublicKey } = PushDrop.decode(output.lockingScript)

          // Parse and validate certificate type registration data
          const type = Utils.toUTF8(fields[0])
          const name = Utils.toUTF8(fields[1])
          const iconURL = Utils.toUTF8(fields[2])
          const description = Utils.toUTF8(fields[3])
          const documentationURL = Utils.toUTF8(fields[4])
          const certFields = JSON.parse(Utils.toUTF8(fields[5]))
          const registryOperator = Utils.toUTF8(fields[6])

          if (typeof type !== 'string') throw new Error('type must be valid')
          if (typeof name !== 'string') throw new Error('name must be valid')
          if (typeof iconURL !== 'string') throw new Error('iconURL must be valid')
          if (typeof description !== 'string') throw new Error('description must be valid')
          if (typeof documentationURL !== 'string') throw new Error('documentationURL must be valid')
          if (typeof certFields !== 'object') throw new Error('fields must be valid')
          if (typeof registryOperator !== 'string') throw new Error('registryOperator must be valid')

          // Ensure lockingPublicKey came from fields[0]
          const keyDeriver = new KeyDeriver('anyone')
          const expected = keyDeriver.derivePublicKey(
            [1, 'certmap'],
            '1',
            registryOperator
          )

          // Make sure keys match
          if (expected.toString() !== lockingPublicKey.toString()) throw new Error('CertMap token not linked to registry operator!')

          const signature = fields.pop() as number[]
          const data = fields.reduce((a, e) => [...a, ...e], [])

          // Verify the signature
          const anyoneWallet = new ProtoWallet('anyone')
          const { valid: hasValidSignature } = await anyoneWallet.verifySignature({
            data,
            signature,
            counterparty: registryOperator,
            protocolID: [1, 'certmap'],
            keyID: '1'
          })
          if (!hasValidSignature) throw new Error('Invalid signature!')

          outputsToAdmit.push(i)
        } catch (error) {
          // It's common for other outputs to be invalid; no need to log an error here
          continue
        }
      }
      if (outputsToAdmit.length === 0) {
        throw new Error('No outputs admitted!')
      }

      // Returns an array of outputs admitted
      // And previousOutputsRetained (none by default)
      console.log('OUTPUTS TO ADMIT:', outputsToAdmit)
      return {
        outputsToAdmit,
        coinsToRetain: []
      }
    } catch (error) {
      // Only log an error if no outputs were admitted and no previous coins consumed
      if (outputsToAdmit.length === 0 && (previousCoins === undefined || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', error)
      }
    }

    console.log('OUTPUTS TO ADMIT:', outputsToAdmit)

    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  /**
   * Returns the documentation for the CertMap topic
   * @public
   * @returns {Promise<string>} - the documentation given as a string
   */
  async getDocumentation(): Promise<string> {
    return docs
  }

  /**
   * Get metadata about the topic manager
   * @returns A promise that resolves to an object containing metadata
   * @throws An error indicating the method is not implemented
   */
  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'CertMap Topic Manager',
      shortDescription: 'Certificate information registration'
    }
  }
}
