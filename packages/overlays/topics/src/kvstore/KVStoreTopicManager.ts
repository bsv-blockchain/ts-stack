import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { ProtoWallet, PushDrop, Transaction, Utils } from '@bsv/sdk'
import { kvProtocol } from './types.js'

export default class KVStoreTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    const parsedTransaction = Transaction.fromBEEF(beef)

    if (!Array.isArray(parsedTransaction.inputs) || parsedTransaction.inputs.length < 1) {
      throw new Error('Missing parameter: inputs')
    }
    if (!Array.isArray(parsedTransaction.outputs) || parsedTransaction.outputs.length < 1) {
      throw new Error('Missing parameter: outputs')
    }

    for (const [i, output] of parsedTransaction.outputs.entries()) {
      try {
        const result = PushDrop.decode(output.lockingScript)

        const expectedFieldCount = Object.keys(kvProtocol).length
        const hasTagsField = result.fields.length === expectedFieldCount
        const isOldFormat = result.fields.length === expectedFieldCount - 1

        if (!isOldFormat && !hasTagsField) {
          continue
        }

        const keyBuffer = result.fields[kvProtocol.key]
        const valueBuffer = result.fields[kvProtocol.value]
        if (!keyBuffer || keyBuffer.length === 0 || !valueBuffer || valueBuffer.length === 0) {
          continue
        }

        const anyoneWallet = new ProtoWallet('anyone')
        const signature = result.fields.pop()!
        const { valid } = await anyoneWallet.verifySignature({
          data: result.fields.flat(),
          signature,
          counterparty: Utils.toHex(result.fields[kvProtocol.controller]),
          protocolID: JSON.parse(Utils.toUTF8(result.fields[kvProtocol.protocolID])),
          keyID: Utils.toUTF8(keyBuffer)
        })
        if (!valid) {
          throw new Error('Invalid KVStore token: signature verification failed')
        }

        outputsToAdmit.push(i)
      } catch (error) {
        // Output does not meet KVStore protocol requirements; skip it
        console.debug(`[KVStoreTopicManager] Skipping output ${i}: ${error}`)
        continue
      }
    }

    if (outputsToAdmit.length > 0) {
      console.log(`Admitted ${outputsToAdmit.length} KVStore output(s)!`)
    }

    if (outputsToAdmit.length === 0 && (previousCoins === undefined || previousCoins.length === 0)) {
      console.warn('No KVStore outputs admitted, and no previous KVStore coins were consumed.')
    }

    return {
      outputsToAdmit,
      coinsToRetain: previousCoins || []
    }
  }

  async getDocumentation(): Promise<string> {
    return 'KVStore Topic Manager: admits PushDrop tokens representing KVStore key-value pairs into an overlay.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'KVStore Topic Manager',
      shortDescription: 'Admits PushDrop tokens representing KVStore key-value pairs into an overlay.',
      version: '0.1.0'
    }
  }
}
