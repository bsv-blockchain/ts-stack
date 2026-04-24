import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { KeyDeriver, ProtocolString5To400Bytes, ProtoWallet, PushDrop, SecurityLevel, Signature, Transaction, Utils, WalletProtocol } from '@bsv/sdk'
import docs from './ProtoMapTopicManagerDocs.md.js'

/**
 * Implements a topic manager for ProtoMap name registry
 * @public
 */
export default class ProtoMapTopicManager implements TopicManager {
  /**
   * Returns the outputs from the ProtoMap transaction that are admissible.
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
        // Decode the ProtoMap registration data
        try {
          const { fields, lockingPublicKey } = PushDrop.decode(output.lockingScript)

          // Parse and validate protocol registration data
          const protocolID = deserializeWalletProtocol(Utils.toUTF8(fields[0]))
          const name = Utils.toUTF8(fields[1])
          const iconURL = Utils.toUTF8(fields[2])
          const description = Utils.toUTF8(fields[3])
          const documentationURL = Utils.toUTF8(fields[4])
          const registryOperator = Utils.toUTF8(fields[5])

          if (
            protocolID === undefined || typeof protocolID[1] !== 'string'
            || (protocolID[0] !== 0 && protocolID[0] !== 1 && protocolID[0] !== 2)
          ) {
            throw new Error('Invalid protocol ID')
          }
          if (name === undefined || typeof name !== 'string') {
            throw new Error('Invalid name')
          }
          if (iconURL === undefined || typeof iconURL !== 'string') {
            throw new Error('Invalid iconURL')
          }
          if (description === undefined || typeof description !== 'string') {
            throw new Error('Invalid description')
          }
          if (documentationURL === undefined || typeof documentationURL !== 'string') {
            throw new Error('Invalid documentationURL')
          }
          if (registryOperator === undefined || typeof registryOperator !== 'string') {
            throw new Error('Invalid registryOperator')
          }

          // Ensure lockingPublicKey came from fields[0]
          const keyDeriver = new KeyDeriver('anyone')
          const expected = keyDeriver.derivePublicKey(
            [1, 'protomap'],
            '1',
            registryOperator
          )

          // Make sure keys match
          if (expected.toString() !== lockingPublicKey.toString()) throw new Error('ProtMap token not linked to registry operator!')

          // Verify the signature
          const signature = fields.pop() as number[]
          const data = fields.reduce((a, e) => [...a, ...e], [])

          // Verify the signature
          const anyoneWallet = new ProtoWallet('anyone')
          const { valid: hasValidSignature } = await anyoneWallet.verifySignature({
            data,
            signature,
            counterparty: registryOperator,
            protocolID: [1, 'protomap'],
            keyID: '1'
          })
          if (!hasValidSignature) throw new Error('Invalid signature!')

          outputsToAdmit.push(i)
        } catch (error) {
          console.log('ERROR', error)
          // It's common for other outputs to be invalid; no need to log an error here
          continue
        }
      }
      if (outputsToAdmit.length === 0) {
        throw new Error('No outputs admitted!')
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
    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  /**
   * Returns the documentation for the ProtoMap topic
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
      name: 'ProtoMap Topic Manager',
      shortDescription: 'Protocol information registration'
    }
  }
}

export function deserializeWalletProtocol(str: string): WalletProtocol {
  // Parse the JSON string back into a JavaScript value.
  const parsed = JSON.parse(str)

  // Validate that the parsed value is an array with exactly two elements.
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error("Invalid wallet protocol format.")
  }

  const [security, protocolString] = parsed

  // Validate that the security level is one of the allowed numbers.
  if (![0, 1, 2].includes(security)) {
    throw new Error("Invalid security level.")
  }

  // Validate that the protocol string is a string and its length is within the allowed bounds.
  if (typeof protocolString !== "string") {
    throw new Error("Invalid protocolID")
  }

  return [security as SecurityLevel, protocolString as ProtocolString5To400Bytes];
}
