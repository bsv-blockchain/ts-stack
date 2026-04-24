import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { KeyDeriver, ProtocolString5To400Bytes, ProtoWallet, PushDrop, SecurityLevel, Transaction, Utils, WalletProtocol } from '@bsv/sdk'

export function deserializeWalletProtocol(str: string): WalletProtocol {
  const parsed = JSON.parse(str)

  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error('Invalid wallet protocol format.')
  }

  const [security, protocolString] = parsed

  if (![0, 1, 2].includes(security)) {
    throw new Error('Invalid security level.')
  }

  if (typeof protocolString !== 'string') {
    throw new Error('Invalid protocolID')
  }

  return [security as SecurityLevel, protocolString as ProtocolString5To400Bytes]
}

export default class ProtoMapTopicManager implements TopicManager {
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
          if (name === undefined || typeof name !== 'string') throw new Error('Invalid name')
          if (iconURL === undefined || typeof iconURL !== 'string') throw new Error('Invalid iconURL')
          if (description === undefined || typeof description !== 'string') throw new Error('Invalid description')
          if (documentationURL === undefined || typeof documentationURL !== 'string') throw new Error('Invalid documentationURL')
          if (registryOperator === undefined || typeof registryOperator !== 'string') throw new Error('Invalid registryOperator')

          const keyDeriver = new KeyDeriver('anyone')
          const expected = keyDeriver.derivePublicKey([1, 'protomap'], '1', registryOperator)
          if (expected.toString() !== lockingPublicKey.toString()) throw new Error('ProtoMap token not linked to registry operator!')

          const signature = fields.pop() as number[]
          const data = fields.reduce((a, e) => [...a, ...e], [])

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
    return 'ProtoMap Topic Manager: register protocol names for service discovery.'
  }

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
