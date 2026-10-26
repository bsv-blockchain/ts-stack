import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { LockingScript } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'
import {
  authenticateRegistryToken,
  registryText,
  registryUrl
} from '../shared/registryTokenValidation.js'

async function validateBasketMapOutput(lockingScript: LockingScript): Promise<void> {
  const [basketID, name, iconURL, description, documentationURL] = await authenticateRegistryToken(
    'basket',
    lockingScript
  )
  registryText(basketID, 'Basket ID', 1, 300)
  registryText(name, 'Basket name', 1, 300)
  registryUrl(iconURL, 'Basket icon URL')
  registryText(description, 'Basket description')
  registryUrl(documentationURL, 'Basket documentation URL')
}

export default class BasketMapTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    return identifyPushDropOutputs({
      beef,
      previousCoins,
      validateOutput: validateBasketMapOutput,
      onRejectedOutput: (outputIndex, error) => {
        console.debug(`[BasketMapTopicManager] Skipping output ${outputIndex}: ${error}`)
      }
    })
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
