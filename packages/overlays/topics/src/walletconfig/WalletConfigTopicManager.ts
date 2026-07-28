import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { KeyDeriver, LockingScript, ProtoWallet, PushDrop, Transaction, Utils } from '@bsv/sdk'
import { assertTransactionInputsAndOutputs } from '../shared/assertTransactionShape.js'

async function validateWalletConfigOutput(lockingScript: LockingScript): Promise<void> {
  const { lockingPublicKey, fields } = PushDrop.decode(lockingScript)

  const configID = Utils.toUTF8(fields[0])
  const name = Utils.toUTF8(fields[1])
  const icon = Utils.toUTF8(fields[2])
  const wab = Utils.toUTF8(fields[3])
  const storage = Utils.toUTF8(fields[4])
  const messagebox = Utils.toUTF8(fields[5])
  const legal = Utils.toUTF8(fields[6])
  const registryOperator = Utils.toUTF8(fields[7])

  if (configID === undefined || typeof configID !== 'string')
    throw new Error('configID param missing!')
  if (name === undefined || typeof name !== 'string') throw new Error('name param missing!')
  if (icon === undefined || typeof icon !== 'string') throw new Error('icon param missing!')
  if (wab === undefined || typeof wab !== 'string') throw new Error('wab param missing!')
  if (storage === undefined || typeof storage !== 'string')
    throw new Error('storage param missing!')
  if (messagebox === undefined || typeof messagebox !== 'string')
    throw new Error('messagebox param missing!')
  if (legal === undefined || typeof legal !== 'string') throw new Error('legal param missing!')
  if (registryOperator === undefined || typeof registryOperator !== 'string')
    throw new Error('registryOperator param missing!')

  const keyDeriver = new KeyDeriver('anyone')
  const expected = keyDeriver.derivePublicKey([1, 'wallet config option'], '1', registryOperator)
  if (expected.toString() !== lockingPublicKey.toString())
    throw new Error('WalletConfig token not linked to registry operator!')

  const signature = fields.at(-1)!
  const data = fields.slice(0, -1).flat()
  const anyoneWallet = new ProtoWallet('anyone')
  const { valid } = await anyoneWallet.verifySignature({
    data,
    signature,
    counterparty: registryOperator,
    protocolID: [1, 'wallet config option'],
    keyID: '1'
  })
  if (!valid) throw new Error('Invalid signature!')
}

export default class WalletConfigTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    try {
      const parsedTransaction = Transaction.fromBEEF(beef)
      assertTransactionInputsAndOutputs(parsedTransaction)

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          await validateWalletConfigOutput(output.lockingScript)
          outputsToAdmit.push(i)
        } catch (error) {
          console.error('Error validating output:', error)
          continue
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('No outputs admitted!')
      return { outputsToAdmit, coinsToRetain: [] }
    } catch (error) {
      if (
        outputsToAdmit.length === 0 &&
        (previousCoins === undefined || previousCoins.length === 0)
      ) {
        console.error('Error identifying admissible outputs:', error)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
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
