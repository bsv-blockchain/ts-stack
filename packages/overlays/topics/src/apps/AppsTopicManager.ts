import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { PushDrop, Transaction, Utils } from '@bsv/sdk'
import { PublishedAppMetadata } from './types.js'
import { isTokenSignatureCorrectlyLinked } from './isTokenSignatureCorrectlyLinked.js'

export default class AppsTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    try {
      console.log('Apps topic manager was invoked')
      const parsedTransaction = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTransaction.inputs) || parsedTransaction.inputs.length < 1) throw new Error('Missing parameter: inputs')
      if (!Array.isArray(parsedTransaction.outputs) || parsedTransaction.outputs.length < 1) throw new Error('Missing parameter: outputs')

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          const result = PushDrop.decode(output.lockingScript)
          if (result.fields.length !== 2) throw new Error('App token must have exactly one metadata field + signature')

          const metadataJSON = Utils.toUTF8(result.fields[0])
          let metadata: PublishedAppMetadata
          try {
            metadata = JSON.parse(metadataJSON)
          } catch (_jsonErr) {
            throw new Error('Metadata field is not valid JSON')
          }

          if (metadata == null) throw new Error('App token must contain valid metadata')

          if (
            typeof metadata?.version !== 'string' ||
            typeof metadata.name !== 'string' ||
            typeof metadata.description !== 'string' ||
            typeof metadata.icon !== 'string' ||
            !(typeof metadata.httpURL === 'string' || typeof metadata.uhrpURL === 'string') ||
            typeof metadata.domain !== 'string' ||
            typeof metadata.publisher !== 'string' ||
            typeof metadata.release_date !== 'string'
          ) {
            throw new TypeError('App metadata missing required fields')
          }

          const isLinked = await isTokenSignatureCorrectlyLinked(result.lockingPublicKey, metadata.publisher, result.fields)
          if (!isLinked) throw new Error('Signature is not properly linked')

          outputsToAdmit.push(i)
        } catch (error) {
          // Output does not meet Apps protocol requirements; skip it
          console.debug(`[AppsTopicManager] Skipping output ${i}: ${error}`)
          continue
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('Apps topic manager: no outputs admitted!')

      return { outputsToAdmit, coinsToRetain: [] }
    } catch (error) {
      if (outputsToAdmit.length === 0 && (previousCoins === undefined || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', error)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
  }

  async getDocumentation(): Promise<string> {
    return 'Apps Topic Manager: admits PushDrop tokens representing published Metanet Apps.'
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'Apps Topic Manager',
      shortDescription: 'Admits PushDrop tokens representing published Metanet Apps into an overlay.',
      version: '0.1.0'
    }
  }
}
