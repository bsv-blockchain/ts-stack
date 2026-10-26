import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { LockingScript, WalletProtocol } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'
import {
  authenticateRegistryToken,
  registryText,
  registryUrl,
  validateRegistryProtocol
} from '../shared/registryTokenValidation.js'

export function deserializeWalletProtocol(str: string): WalletProtocol {
  return validateRegistryProtocol(str)
}

async function validateProtoMapOutput(lockingScript: LockingScript): Promise<void> {
  const [serializedProtocolID, name, iconURL, description, documentationURL] =
    await authenticateRegistryToken('protocol', lockingScript)
  validateRegistryProtocol(serializedProtocolID)
  registryText(name, 'Protocol name', 1, 300)
  registryUrl(iconURL, 'Protocol icon URL')
  registryText(description, 'Protocol description')
  registryUrl(documentationURL, 'Protocol documentation URL')
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
