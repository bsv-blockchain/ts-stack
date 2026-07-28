import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { KeyDeriver, LockingScript, ProtoWallet, PushDrop, Utils } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'

async function validateCertMapOutput(lockingScript: LockingScript): Promise<void> {
  const { fields, lockingPublicKey } = PushDrop.decode(lockingScript)

  const type = Utils.toUTF8(fields[0])
  const name = Utils.toUTF8(fields[1])
  const iconURL = Utils.toUTF8(fields[2])
  const description = Utils.toUTF8(fields[3])
  const documentationURL = Utils.toUTF8(fields[4])
  const certFields = JSON.parse(Utils.toUTF8(fields[5]))
  const registryOperator = Utils.toUTF8(fields[6])

  if (typeof type !== 'string') throw new Error('type must be valid')
  if (typeof name !== 'string') throw new Error('name must be valid')
  if (typeof iconURL !== 'string') throw new Error('iconURL must be valid')
  if (typeof description !== 'string') throw new Error('description must be valid')
  if (typeof documentationURL !== 'string') throw new Error('documentationURL must be valid')
  if (typeof certFields !== 'object') throw new Error('fields must be valid')
  if (typeof registryOperator !== 'string') throw new Error('registryOperator must be valid')

  const keyDeriver = new KeyDeriver('anyone')
  const expected = keyDeriver.derivePublicKey([1, 'certmap'], '1', registryOperator)
  if (expected.toString() !== lockingPublicKey.toString())
    throw new Error('CertMap token not linked to registry operator!')

  const signature = fields.pop()!
  const data = fields.flat()
  const anyoneWallet = new ProtoWallet('anyone')
  const { valid } = await anyoneWallet.verifySignature({
    data,
    signature,
    counterparty: registryOperator,
    protocolID: [1, 'certmap'],
    keyID: '1'
  })
  if (!valid) throw new Error('Invalid signature!')
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
