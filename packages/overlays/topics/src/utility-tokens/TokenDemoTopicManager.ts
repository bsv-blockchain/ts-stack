import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { OP, Transaction, PushDrop, Utils } from '@bsv/sdk'

export default class TokenDemoTopicManager implements TopicManager {
  async identifyNeededInputs(beef: number[], offChainValues?: number[]): Promise<Array<{ txid: string, outputIndex: number }>> {
    console.log('identifyNeededInputs called')
    const tx = Transaction.fromBEEF(beef)

    if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) throw new Error('Missing parameter: inputs')

    const previousOutpoints: Array<{ txid: string, outputIndex: number }> = []
    tx.inputs.forEach(input => {
      if (!input.sourceTransaction) {
        previousOutpoints.push({ txid: input.sourceTXID, outputIndex: input.sourceOutputIndex })
      }
    })
    return previousOutpoints
  }

  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    console.log({ previousCoins })
    const outputsToAdmit: number[] = []
    const coinsToRetain: number[] = []

    try {
      console.log('TokenDemo topic manager invoked')
      const parsedTx = Transaction.fromBEEF(beef)
      const txid = parsedTx.id('hex')

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      const internalAssetBalances = new Map<string, { amount: number, isMint: boolean }>()

      for (const [index, input] of parsedTx.inputs.entries()) {
        if (!previousCoins.includes(index)) continue
        try {
          const sourceTxid = input.sourceTransaction.id('hex')
          const token = PushDrop.decode(input.sourceTransaction.outputs[input.sourceOutputIndex].lockingScript)
          const r = new Utils.Reader(token.fields[1])
          const amount = String(r.readUInt64LEBn())
          const customFields = JSON.parse(Utils.toUTF8(token.fields[2]))
          const details = { tokenId: Utils.toUTF8(token.fields[0]), amount, customFields }
          const currentAmount = internalAssetBalances.get(details.tokenId)?.amount || 0
          if (details.tokenId === '___mint___') {
            internalAssetBalances.set(sourceTxid + '.' + input.sourceOutputIndex, { isMint: true, amount: currentAmount + Number(amount) })
          } else {
            internalAssetBalances.set(details.tokenId, { isMint: false, amount: currentAmount + Number(amount) })
          }
          coinsToRetain.push(index)
        } catch (err) {
          console.error(`Error processing input ${index}:`, err)
        }
      }

      for (const [index, output] of parsedTx.outputs.entries()) {
        try {
          if (output.lockingScript.chunks[1].op !== OP.OP_CHECKSIG) continue
          const token = PushDrop.decode(output.lockingScript)
          const r = new Utils.Reader(token.fields[1])
          const amount = String(r.readUInt64LEBn())
          const customFields = JSON.parse(Utils.toUTF8(token.fields[2]))
          const details = { tokenId: Utils.toUTF8(token.fields[0]), amount, customFields }
          const currentAmount = internalAssetBalances.get(details.tokenId)?.amount || 0
          if (details.tokenId === '___mint___') {
            internalAssetBalances.set(txid + '.' + String(index), { isMint: true, amount: currentAmount - Number(amount) })
          } else {
            internalAssetBalances.set(details.tokenId, { isMint: false, amount: currentAmount - Number(amount) })
          }
          outputsToAdmit.push(index)
        } catch (err) {
          console.info(`Could not process output ${index}:`, err)
        }
      }

      for (const [tokenId, balance] of internalAssetBalances.entries()) {
        if (balance.amount !== 0 && !balance.isMint) {
          console.error(`Unbalanced assets for non-mint token ${tokenId}`)
          return { outputsToAdmit: [], coinsToRetain: [] }
        }
      }

      if (outputsToAdmit.length === 0) throw new Error('TokenDemo topic manager: no outputs admitted!')
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    return { outputsToAdmit, coinsToRetain: [] }
  }

  async getDocumentation(): Promise<string> {
    return "TokenDemo Topic Manager: what's your message to the world?"
  }

  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'TokenDemo Topic Manager',
      shortDescription: "What's your message to the world?"
    }
  }
}
