import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { KeyDeriver, ProtoWallet, PushDrop, Transaction, Utils } from '@bsv/sdk'

export default class CertMapTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    try {
      const parsedTransaction = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTransaction.inputs) || parsedTransaction.inputs.length < 1) {
        throw new Error('Transaction inputs must be valid')
      }
      if (!Array.isArray(parsedTransaction.outputs) || parsedTransaction.outputs.length < 1) {
        throw new Error('Transaction outputs must be valid')
      }

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          const { fields, lockingPublicKey } = PushDrop.decode(output.lockingScript)

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

          const keyDeriver = new KeyDeriver('anyone')
          const expected = keyDeriver.derivePublicKey([1, 'certmap'], '1', registryOperator)
          if (expected.toString() !== lockingPublicKey.toString()) throw new Error('CertMap token not linked to registry operator!')

          const signature = fields.pop()!
          const data = fields.flat()

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
          // Output does not meet CertMap protocol requirements; skip it
          console.debug(`[CertMapTopicManager] Skipping output ${i}: ${error}`)
          continue
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('No outputs admitted!')

      return { outputsToAdmit, coinsToRetain: [] }
    } catch (error) {
      if (outputsToAdmit.length === 0 && (previousCoins === undefined || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', error)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
  }

  async getDocumentation(): Promise<string> {
    return 'CertMap Topic Manager: register certificate type information for service discovery.'
  }

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
