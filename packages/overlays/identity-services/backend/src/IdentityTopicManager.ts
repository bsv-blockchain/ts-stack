import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { ProtoWallet, PushDrop, Transaction, Utils, VerifiableCertificate } from '@bsv/sdk'
import docs from './docs/IdentityTopicManagerDocs.md.js'

/**
 * Implements a topic manager for Identity key registry
 * @public
 */
export default class IdentityTopicManager implements TopicManager {
  /**
   * Returns the outputs from the Identity transaction that are admissible.
   * @param beef - The transaction data in BEEF format
   * @param previousCoins - The previous coins to consider
   * @returns A promise that resolves with the admittance instructions
   */
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    try {
      console.log('Identity topic manager was invoked')
      const parsedTransaction = Transaction.fromBEEF(beef)

      // Validate params
      if (!Array.isArray(parsedTransaction.inputs) || parsedTransaction.inputs.length < 1) throw new Error('Missing parameter: inputs')
      if (!Array.isArray(parsedTransaction.outputs) || parsedTransaction.outputs.length < 1) throw new Error('Missing parameter: outputs')
      console.log('Identity topic manager has parsed a the transaction: ', parsedTransaction.id('hex'))

      const anyoneWallet = new ProtoWallet('anyone')

      // Try to decode and validate transaction outputs
      for (const [i, output] of parsedTransaction.outputs.entries()) {
        // Decode the Identity fields
        try {
          const result = PushDrop.decode(output.lockingScript)
          const parsedCert = JSON.parse(Utils.toUTF8(result.fields[0]))
          const certificate = new VerifiableCertificate(
            parsedCert.type,
            parsedCert.serialNumber,
            parsedCert.subject,
            parsedCert.certifier,
            parsedCert.revocationOutpoint,
            parsedCert.fields,
            parsedCert.keyring,
            parsedCert.signature
          )

          // First, we ensure that the signature over the data is valid for the claimed identity key.
          const signature = result.fields.pop() as number[]
          const data: number[] = []
          for (const field of result.fields) {
            data.push(...field)
          }

          const { valid: hasValidSignature } = await anyoneWallet.verifySignature({
            data,
            signature,
            counterparty: parsedCert.subject,
            protocolID: [1, 'identity'],
            keyID: '1'
          })
          if (!hasValidSignature) throw new Error('Invalid signature!')

          // Ensure validity of the certificate signature
          const valid = await certificate.verify()
          if (!valid) {
            throw new Error('Invalid certificate signature!')
          }

          // Ensure the fields are properly revealed and can be decrypted
          const decryptedFields = await certificate.decryptFields(anyoneWallet)
          if (Object.keys(decryptedFields).length === 0) throw new Error('No publicly revealed attributes present!')

          outputsToAdmit.push(i)
        } catch (error) {
          console.error(`Error parsing output ${i}`, error)
          // It's common for other outputs to be invalid; no need to log an error here
          continue
        }
      }
      if (outputsToAdmit.length === 0) {
        throw new Error('Identity topic manager: no outputs admitted!')
      }

      // Returns an array of outputs admitted
      // And previousOutputsRetained (none by default)
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

    if (outputsToAdmit.length > 0) {
      console.log(`Admitted ${outputsToAdmit.length} Identity ${outputsToAdmit.length === 1 ? 'output' : 'outputs'}!`)
    }

    if (previousCoins !== undefined && previousCoins.length > 0) {
      console.log(`Consumed ${previousCoins.length} previous Identity ${previousCoins.length === 1 ? 'coin' : 'coins'}!`)
    }

    if (outputsToAdmit.length === 0 && (previousCoins === undefined || previousCoins.length === 0)) {
      console.warn('No Identity outputs admitted, and no previous Identity coins were consumed.')
    }

    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  // TODO: Consider supporting identifyNeededInputs
  // identifyNeededInputs?: ((beef: number[]) => Promise<Array<{ txid: string; outputIndex: number }>>) | undefined

  /**
   * Get the documentation associated with this Identity topic manager
   * @returns A promise that resolves to a string containing the documentation
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
      name: 'Identity Topic Manager',
      shortDescription: 'Identity Resolution Protocol'
    }
  }
}
