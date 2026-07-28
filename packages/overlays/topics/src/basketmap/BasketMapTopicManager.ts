import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { LockingScript, PushDrop } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'
import {
  decodeRegistryUtf8Fields,
  verifyRegistryToken
} from '../shared/registryTokenValidation.js'

async function validateBasketMapOutput(lockingScript: LockingScript): Promise<void> {
  const { lockingPublicKey, fields } = PushDrop.decode(lockingScript)

  const [, , , , , registryOperator] = decodeRegistryUtf8Fields(fields, 6)
  await verifyRegistryToken({
    fields,
    lockingPublicKey,
    registryOperator,
    protocolID: [1, 'basketmap'],
    linkageError: 'BasketMap token not linked to registry operator!'
  })
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
