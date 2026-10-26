import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { LockingScript } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'
import {
  authenticateRegistryToken,
  registryObject,
  registryText,
  registryUrl
} from '../shared/registryTokenValidation.js'

async function validateCertMapOutput(lockingScript: LockingScript): Promise<void> {
  const [type, name, iconURL, description, documentationURL, serializedCertFields] =
    await authenticateRegistryToken('certificate', lockingScript)
  registryText(type, 'Certificate type', 1, 300)
  registryText(name, 'Certificate name', 1, 300)
  registryUrl(iconURL, 'Certificate icon URL')
  registryText(description, 'Certificate description')
  registryUrl(documentationURL, 'Certificate documentation URL')
  const certFields: unknown = JSON.parse(serializedCertFields)
  const fields = registryObject(certFields, 'Certificate fields')
  if (Object.keys(fields).length > 64)
    throw new Error('Certificate fields contains too many entries')
  for (const [fieldName, descriptorValue] of Object.entries(fields)) {
    registryText(fieldName, 'Certificate field name', 1, 50)
    const descriptor = registryObject(descriptorValue, `Certificate field ${fieldName}`)
    if (
      Object.keys(descriptor).some(
        key => !['friendlyName', 'description', 'type', 'fieldIcon'].includes(key)
      )
    ) {
      throw new Error(`Certificate field ${fieldName} contains an unknown property`)
    }
    if (
      descriptor.type !== 'text' &&
      descriptor.type !== 'imageURL' &&
      descriptor.type !== 'other'
    ) {
      throw new Error(`Certificate field ${fieldName} has an unsupported type`)
    }
    registryText(descriptor.friendlyName, `${fieldName}.friendlyName`, 1, 300)
    registryText(descriptor.description, `${fieldName}.description`)
    registryUrl(descriptor.fieldIcon, `${fieldName}.fieldIcon`)
  }
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
