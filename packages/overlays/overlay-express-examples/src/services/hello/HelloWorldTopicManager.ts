import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Signature, Transaction, PushDrop, Utils } from '@bsv/sdk'
import docs from './HelloWorldTopicDocs.js'

/**
 * Topic manager for the simple "Hello‑World" messaging protocol.
 *
 * Each valid output must satisfy the following rules:
 *   1. It is a BRC‑48 Pay‑to‑Push‑Drop output (decoded with {@link PushDrop}).
 *   2. The drop contains **exactly one** field – the UTF‑8 message.
 *   3. The message is at least two characters long.
 *   4. The signature inside the drop must verify against the locking public key
 *      over the concatenated field data.
 */
export default class HelloWorldTopicManager implements TopicManager {
  /**
   * Identify which outputs in the supplied transaction are admissible.
   *
   * @param beef          Raw transaction encoded in BEEF format.
   * @param previousCoins Previously‑retained coins (unused by this protocol).
   */
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      console.log('HelloWorld topic manager invoked')
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      // Inspect every output
      for (const [index, output] of parsedTx.outputs.entries()) {
        try {
          const result = PushDrop.decode(output.lockingScript)
          const signature = result.fields.pop()

          // 1) Must contain exactly one field (not including the signature)
          if (!result.fields || result.fields.length !== 1) continue

          const message = Utils.toUTF8(result.fields[0])
          // 2) Message must be at least two characters
          if (message.length < 2) continue

          // 3) Verify the signature against the locking public key
          if (!result.lockingPublicKey || !signature) continue

          const data = result.fields.reduce((a, e) => [...a, ...e], [])
          const hasValidSignature = await result.lockingPublicKey.verify(
            data,
            Signature.fromDER(signature)
          )
          if (!hasValidSignature) throw new Error('Invalid signature!')
          outputsToAdmit.push(index)
        } catch (err) {
          console.error(`Error processing output ${index}:`, err)
          // Continue with next output
        }
      }

      if (outputsToAdmit.length === 0) {
        throw new Error('HelloWorld topic manager: no outputs admitted!')
      }

      console.log(`Admitted ${outputsToAdmit.length} HelloWorld ${outputsToAdmit.length === 1 ? 'output' : 'outputs'}!`)
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    // The HelloWorld protocol never retains previous coins
    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  /**
   * Get the documentation associated with this topic manager
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
      name: 'HelloWorld Topic Manager',
      shortDescription: "What's your message to the world?"
    }
  }
}
