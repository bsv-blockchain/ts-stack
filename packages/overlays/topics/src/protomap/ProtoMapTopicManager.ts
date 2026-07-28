import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import {
  LockingScript,
  PushDrop,
  SecurityLevel,
  WalletProtocol
} from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'
import {
  decodeRegistryUtf8Fields,
  verifyRegistryToken
} from '../shared/registryTokenValidation.js'

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

  const [serializedProtocolID, , , , , registryOperator] = decodeRegistryUtf8Fields(fields, 6)
  deserializeWalletProtocol(serializedProtocolID)
  await verifyRegistryToken({
    fields,
    lockingPublicKey,
    registryOperator,
    protocolID: [1, 'protomap'],
    linkageError: 'ProtoMap token not linked to registry operator!'
  })
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
