import { PushDrop, ProtoWallet, Utils, Transaction } from '@bsv/sdk'
import type { AdmittanceInstructions, TopicManager } from '@bsv/overlay'

const anyoneWallet = new ProtoWallet('anyone')

export default class MessageBoxTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    const tx = Transaction.fromBEEF(beef)

    console.log(`[TOPIC MANAGER] Decoding transaction with ${tx.outputs.length} outputs`)

    for (const [i, output] of tx.outputs.entries()) {
      try {
        const result = PushDrop.decode(output.lockingScript)
        const signature = result.fields.pop() as number[]
        const [identityKeyBuf, hostBuf] = result.fields

        if (!identityKeyBuf || !hostBuf || identityKeyBuf.length === 0 || hostBuf.length === 0) continue

        let host: string
        try {
          host = Utils.toUTF8(hostBuf)
        } catch {
          continue
        }

        const identityKey = Utils.toHex(identityKeyBuf)
        const data = result.fields.reduce((a, e) => [...a, ...e], [])

        const { valid } = await anyoneWallet.verifySignature({
          data,
          signature,
          counterparty: identityKey,
          protocolID: [1, 'messagebox advertisement'],
          keyID: '1'
        })

        if (valid) outputsToAdmit.push(i)
      } catch (e) {
        console.warn(`[DECODE ERROR] Skipping output ${i} due to exception:`, e)
      }
    }

    return { outputsToAdmit, coinsToRetain: previousCoins }
  }

  async getDocumentation(): Promise<string> {
    return 'MessageBox Topic Manager: advertises and validates hosts for message routing.'
  }

  async getMetaData() {
    return {
      name: 'MessageBox Topic Manager',
      shortDescription: 'Advertises and validates hosts for message routing.'
    }
  }

  getTopics(): string[] {
    return ['tm_messagebox']
  }
}
