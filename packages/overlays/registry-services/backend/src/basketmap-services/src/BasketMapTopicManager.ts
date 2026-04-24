import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { KeyDeriver, ProtoWallet, PushDrop, Signature, Transaction, Utils } from '@bsv/sdk'
import docs from './docs/BasketMapTopicManagerDocs.md.js'

/**
 * Implements a topic manager for BasketMap name registry
 * @public
 */
export default class BasketMapTopicManager implements TopicManager {
  /**
   * Returns the outputs from the BasketMap transaction that are admissible.
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
        // Decode the BasketMap registration data
        try {
          const { lockingPublicKey, fields } = PushDrop.decode(output.lockingScript)

          //  Parse and validate basket type registration data
          const basketID = Utils.toUTF8(fields[0])
          const name = Utils.toUTF8(fields[1])
          const iconURL = Utils.toUTF8(fields[2])
          const description = Utils.toUTF8(fields[3])
          const documentationURL = Utils.toUTF8(fields[4])
          const registryOperator = Utils.toUTF8(fields[5])

          if (basketID === undefined || typeof basketID !== 'string') {
            throw new Error('basketID param missing!')
          }
          if (name === undefined || typeof name !== 'string') {
            throw new Error('name param missing!')
          }
          // TODO: validate UHRP URL
          if (iconURL === undefined || typeof iconURL !== 'string') {
            throw new Error('iconURL param missing!')
          }
          if (description === undefined || typeof description !== 'string') {
            throw new Error('description param missing!')
          }
          // TODO: validate URL
          if (documentationURL === undefined || typeof documentationURL !== 'string') {
            throw new Error('documentationURL param missing!')
          }
          if (registryOperator === undefined || typeof registryOperator !== 'string') {
            throw new Error('documentationURL param missing!')
          }

          // Ensure lockingPublicKey came from fields[0]
          // Either the certifier or the subject must control the basket token.
          const keyDeriver = new KeyDeriver('anyone')
          const expected = keyDeriver.derivePublicKey(
            [1, 'basketmap'],
            '1',
            registryOperator
          )

          // Make sure keys match
          if (expected.toString() !== lockingPublicKey.toString()) {
            throw new Error('BasketMap token not linked registry operator!')
          }

          // Verify the signature
          const signature = fields.pop() as number[]
          const data = fields.reduce((a, e) => [...a, ...e], [])

          // Verify the signature
          const anyoneWallet = new ProtoWallet('anyone')
          const { valid: hasValidSignature } = await anyoneWallet.verifySignature({
            data,
            signature,
            counterparty: registryOperator,
            protocolID: [1, 'basketmap'],
            keyID: '1'
          })
          if (!hasValidSignature) throw new Error('Invalid signature!')

          outputsToAdmit.push(i)
        } catch (error) {
          console.error('ERROR', error)
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
   * Returns the documentation for the BasketMap topic
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
      name: 'tm_basketmap',
      shortDescription: 'BasketMap Registration Protocol'
    }
  }
}
