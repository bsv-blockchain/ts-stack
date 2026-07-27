import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Signature, Transaction, PushDrop, Utils, type TransactionOutput } from '@bsv/sdk'

function isAdmissibleHelloWorldOutput (output: TransactionOutput): boolean {
  const result = PushDrop.decode(output.lockingScript)
  const signature = result.fields.pop()

  if (result.fields?.length !== 1) return false

  const message = Utils.toUTF8(result.fields[0])
  if (message.length < 2) return false
  if (!result.lockingPublicKey || !signature) return false

  const data = result.fields.flat()
  const hasValidSignature = result.lockingPublicKey.verify(data, Signature.fromDER(signature))
  if (!hasValidSignature) throw new Error('Invalid signature!')
  return true
}

export default class HelloWorldTopicManager implements TopicManager {
  async identifyAdmissibleOutputs (beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      console.log('HelloWorld topic manager invoked')
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      for (const [index, output] of parsedTx.outputs.entries()) {
        try {
          if (isAdmissibleHelloWorldOutput(output)) outputsToAdmit.push(index)
        } catch (err) {
          console.error(`Error processing output ${index}:`, err)
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('HelloWorld topic manager: no outputs admitted!')
      console.log(`Admitted ${outputsToAdmit.length} HelloWorld output(s)!`)
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
  }

  async getDocumentation (): Promise<string> {
    return "HelloWorld Topic Manager: what's your message to the world?"
  }

  async getMetaData (): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'HelloWorld Topic Manager',
      shortDescription: "What's your message to the world?"
    }
  }
}
