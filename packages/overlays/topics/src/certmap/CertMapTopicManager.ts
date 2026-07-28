import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { LockingScript, PushDrop } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'
import {
  decodeRegistryUtf8Fields,
  verifyRegistryToken
} from '../shared/registryTokenValidation.js'

async function validateCertMapOutput(lockingScript: LockingScript): Promise<void> {
  const { fields, lockingPublicKey } = PushDrop.decode(lockingScript)

  const [, , , , , serializedCertFields, registryOperator] = decodeRegistryUtf8Fields(fields, 7)
  const certFields: unknown = JSON.parse(serializedCertFields)
  if (typeof certFields !== 'object') throw new Error('fields must be valid')
  await verifyRegistryToken({
    fields,
    lockingPublicKey,
    registryOperator,
    protocolID: [1, 'certmap'],
    linkageError: 'CertMap token not linked to registry operator!'
  })
}

export default class CertMapTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    return identifyPushDropOutputs({
      beef,
      previousCoins,
      validateOutput: validateCertMapOutput,
      onRejectedOutput: (outputIndex, error) => {
        console.debug(`[CertMapTopicManager] Skipping output ${outputIndex}: ${error}`)
      }
    })
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
