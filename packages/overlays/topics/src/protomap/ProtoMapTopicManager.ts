import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import {
  KeyDeriver,
  LockingScript,
  ProtoWallet,
  PushDrop,
  SecurityLevel,
  Utils,
  WalletProtocol
} from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'

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
    throw new TypeError('Invalid protocolID')
  }

  return [security as SecurityLevel, protocolString]
}

async function validateProtoMapOutput(lockingScript: LockingScript): Promise<void> {
  const { fields, lockingPublicKey } = PushDrop.decode(lockingScript)

  const protocolID = deserializeWalletProtocol(Utils.toUTF8(fields[0]))
  const name = Utils.toUTF8(fields[1])
  const iconURL = Utils.toUTF8(fields[2])
  const description = Utils.toUTF8(fields[3])
  const documentationURL = Utils.toUTF8(fields[4])
  const registryOperator = Utils.toUTF8(fields[5])

  if (
    protocolID === undefined ||
    typeof protocolID[1] !== 'string' ||
    (protocolID[0] !== 0 && protocolID[0] !== 1 && protocolID[0] !== 2)
  ) {
    throw new Error('Invalid protocol ID')
  }
  if (name === undefined || typeof name !== 'string') throw new Error('Invalid name')
  if (iconURL === undefined || typeof iconURL !== 'string') throw new Error('Invalid iconURL')
  if (description === undefined || typeof description !== 'string')
    throw new Error('Invalid description')
  if (documentationURL === undefined || typeof documentationURL !== 'string')
    throw new Error('Invalid documentationURL')
  if (registryOperator === undefined || typeof registryOperator !== 'string')
    throw new Error('Invalid registryOperator')

  const keyDeriver = new KeyDeriver('anyone')
  const expected = keyDeriver.derivePublicKey([1, 'protomap'], '1', registryOperator)
  if (expected.toString() !== lockingPublicKey.toString())
    throw new Error('ProtoMap token not linked to registry operator!')

  const signature = fields.pop()!
  const data = fields.flat()
  const anyoneWallet = new ProtoWallet('anyone')
  const { valid } = await anyoneWallet.verifySignature({
    data,
    signature,
    counterparty: registryOperator,
    protocolID: [1, 'protomap'],
    keyID: '1'
  })
  if (!valid) throw new Error('Invalid signature!')
}

export default class ProtoMapTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    return identifyPushDropOutputs({
      beef,
      previousCoins,
      validateOutput: validateProtoMapOutput,
      onRejectedOutput: (outputIndex, error) => {
        console.debug(`[ProtoMapTopicManager] Skipping output ${outputIndex}: ${error}`)
      }
    })
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
