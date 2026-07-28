import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { KeyDeriver, LockingScript, ProtoWallet, PushDrop, Utils } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../shared/identifyPushDropOutputs.js'

async function validateBasketMapOutput(lockingScript: LockingScript): Promise<void> {
  const { lockingPublicKey, fields } = PushDrop.decode(lockingScript)

  const basketID = Utils.toUTF8(fields[0])
  const name = Utils.toUTF8(fields[1])
  const iconURL = Utils.toUTF8(fields[2])
  const description = Utils.toUTF8(fields[3])
  const documentationURL = Utils.toUTF8(fields[4])
  const registryOperator = Utils.toUTF8(fields[5])

  if (basketID === undefined || typeof basketID !== 'string')
    throw new Error('basketID param missing!')
  if (name === undefined || typeof name !== 'string') throw new Error('name param missing!')
  if (iconURL === undefined || typeof iconURL !== 'string')
    throw new Error('iconURL param missing!')
  if (description === undefined || typeof description !== 'string')
    throw new Error('description param missing!')
  if (documentationURL === undefined || typeof documentationURL !== 'string')
    throw new Error('documentationURL param missing!')
  if (registryOperator === undefined || typeof registryOperator !== 'string')
    throw new Error('registryOperator param missing!')

  const keyDeriver = new KeyDeriver('anyone')
  const expected = keyDeriver.derivePublicKey([1, 'basketmap'], '1', registryOperator)
  if (expected.toString() !== lockingPublicKey.toString())
    throw new Error('BasketMap token not linked to registry operator!')

  const signature = fields.pop()!
  const data = fields.flat()
  const anyoneWallet = new ProtoWallet('anyone')
  const { valid } = await anyoneWallet.verifySignature({
    data,
    signature,
    counterparty: registryOperator,
    protocolID: [1, 'basketmap'],
    keyID: '1'
  })
  if (!valid) throw new Error('Invalid signature!')
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
