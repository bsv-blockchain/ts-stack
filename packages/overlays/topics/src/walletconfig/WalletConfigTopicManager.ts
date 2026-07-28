import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { LockingScript, PushDrop } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'
import {
  decodeRegistryUtf8Fields,
  verifyRegistryToken
} from '../shared/registryTokenValidation.js'

async function validateWalletConfigOutput(lockingScript: LockingScript): Promise<void> {
  const { lockingPublicKey, fields } = PushDrop.decode(lockingScript)

  const [, , , , , , , registryOperator] = decodeRegistryUtf8Fields(fields, 8)
  await verifyRegistryToken({
    fields,
    lockingPublicKey,
    registryOperator,
    protocolID: [1, 'wallet config option'],
    linkageError: 'WalletConfig token not linked to registry operator!'
  })
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
