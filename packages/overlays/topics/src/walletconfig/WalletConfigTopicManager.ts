import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { LockingScript } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'
import {
  authenticateSignedRegistryToken,
  registryText,
  registryUrl
} from '../shared/registryTokenValidation.js'

async function validateWalletConfigOutput(lockingScript: LockingScript): Promise<void> {
  const [configID, name, icon, wab, storage, messagebox, legal] =
    await authenticateSignedRegistryToken(lockingScript, 8, [1, 'wallet config option'])
  registryText(configID, 'Wallet config ID', 1, 300)
  registryText(name, 'Wallet config name', 1, 300)
  registryUrl(icon, 'Wallet config icon')
  registryUrl(wab, 'WAB URL')
  registryUrl(storage, 'Storage URL')
  registryUrl(messagebox, 'Message Box URL')
  registryUrl(legal, 'Legal URL')
}

export default class WalletConfigTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    return identifyPushDropOutputs({
      beef,
      previousCoins,
      validateOutput: validateWalletConfigOutput,
      onRejectedOutput: (_outputIndex, error) => {
        console.error('Error validating output:', error)
      }
    })
  }

  async getDocumentation(): Promise<string> {
    return 'WalletConfig Topic Manager: register wallet configuration options for service discovery.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'WalletConfig',
      shortDescription: 'Register wallet configuration options for service discovery'
    }
  }
}
