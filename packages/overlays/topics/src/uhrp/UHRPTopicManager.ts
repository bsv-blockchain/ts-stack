import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Transaction, PushDrop, Utils } from '@bsv/sdk'
import { isTokenSignatureCorrectlyLinked } from './isTokenSignatureCorrectlyLinked.js'

export default class UHRPTopicManager implements TopicManager {
  identifyNeededInputs?: (beef: number[]) => Promise<Array<{ txid: string; outputIndex: number }>>

  async getDocumentation(): Promise<string> {
    return 'Universal Hash Resolution Protocol: manages UHRP content availability advertisements.'
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string; iconURL?: string; version?: string; informationURL?: string }> {
    return {
      name: 'Universal Hash Resolution Protocol',
      shortDescription: 'Manages UHRP content availability advertisements.'
    }
  }

  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    try {
      console.log('previous UTXOs', previousCoins.length)
      const outputs: number[] = []
      const parsedTransaction = Transaction.fromBEEF(beef)

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          const result = PushDrop.decode(output.lockingScript)
          if (result.fields.length < 5) throw new Error('Invalid UHRP token')
          const isLinked = await isTokenSignatureCorrectlyLinked(result.lockingPublicKey, result.fields)
          if (!isLinked) throw new Error('Signature is not properly linked')
          if (result.fields[1].length !== 32) throw new Error('Invalid hash length')
          const fileLocationString = Utils.toUTF8(result.fields[2])
          const fileLocationURL = new URL(fileLocationString)
          if (fileLocationURL.protocol !== 'https:') throw new Error('Advertisement must be on HTTPS')
          const expiryTime = new Utils.Reader(result.fields[3]).readVarIntNum()
          const fileSize = new Utils.Reader(result.fields[4]).readVarIntNum()
          if (expiryTime < 1 || fileSize < 1) throw new Error('Invalid expiry time or file size')
          outputs.push(i)
        } catch (error) {
          console.error('Error with output', i, error)
        }
      }

      if (outputs.length === 0) throw new Error('This transaction does not publish a valid CWI account descriptor!')

      return { coinsToRetain: previousCoins, outputsToAdmit: outputs }
    } catch (error) {
      console.warn(`[UHRPTopicManager] identifyAdmissibleOutputs failed: ${error}`)
      return { coinsToRetain: [], outputsToAdmit: [] }
    }
  }
}
