import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { KeyDeriver, ProtoWallet, PushDrop, Transaction, Utils } from '@bsv/sdk'

export default class BasketMapTopicManager implements TopicManager {
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
          const { lockingPublicKey, fields } = PushDrop.decode(output.lockingScript)

          const basketID = Utils.toUTF8(fields[0])
          const name = Utils.toUTF8(fields[1])
          const iconURL = Utils.toUTF8(fields[2])
          const description = Utils.toUTF8(fields[3])
          const documentationURL = Utils.toUTF8(fields[4])
          const registryOperator = Utils.toUTF8(fields[5])

          if (basketID === undefined || typeof basketID !== 'string') throw new Error('basketID param missing!')
          if (name === undefined || typeof name !== 'string') throw new Error('name param missing!')
          if (iconURL === undefined || typeof iconURL !== 'string') throw new Error('iconURL param missing!')
          if (description === undefined || typeof description !== 'string') throw new Error('description param missing!')
          if (documentationURL === undefined || typeof documentationURL !== 'string') throw new Error('documentationURL param missing!')
          if (registryOperator === undefined || typeof registryOperator !== 'string') throw new Error('registryOperator param missing!')

          const keyDeriver = new KeyDeriver('anyone')
          const expected = keyDeriver.derivePublicKey([1, 'basketmap'], '1', registryOperator)
          if (expected.toString() !== lockingPublicKey.toString()) throw new Error('BasketMap token not linked to registry operator!')

          const signature = fields.pop()!
          const data = fields.flat()

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
    return 'BasketMap Topic Manager: register basket type names for service discovery.'
  }

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
