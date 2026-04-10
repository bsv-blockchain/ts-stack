import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { OP, Transaction, PushDrop, Utils } from '@bsv/sdk'
import docs from './TokenDemoTopicDocs.md'

export default class TokenDemoTopicManager implements TopicManager {

  async identifyNeededInputs(
    beef: number[],
    offChainValues?: number[]
  ): Promise<Array<{ txid: string, outputIndex: number }>> {
    console.log('identifyNeededInputs called');
      const tx = Transaction.fromBEEF(beef)
      
      if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) {
        throw new Error('Missing parameter: inputs')
      }

      const previousOutpoints: Array<{ txid: string, outputIndex: number }> = []
      tx.inputs.forEach(input => {
        if (!input.sourceTransaction)
          previousOutpoints.push({ txid: input.sourceTXID, outputIndex: input.sourceOutputIndex })
      })

      return previousOutpoints
  }

  /**
   * Identify which outputs in the supplied transaction are admissible.
   *
   * @param beef          Raw transaction encoded in BEEF format.
   * @param previousCoins Previously‑retained coins (unused by this protocol).
   */
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    console.log({ previousCoins });
    const outputsToAdmit: number[] = []
    const coinsToRetain: number[] = []

    try {
      console.log('TokenDemo topic manager invoked')
      const parsedTx = Transaction.fromBEEF(beef)
      const txid = parsedTx.id('hex')

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }


      console.log(`| tx ---------------------------------|`)

      const internalAssetBalances = new Map<string, { amount: number, isMint: boolean }>()    

      // Inspect every input
      for (const [index, input] of parsedTx.inputs.entries()) {
        if (!previousCoins.includes(index)) continue
        try {
          const sourceTxid = input.sourceTransaction.id('hex')
          const token = PushDrop.decode(input.sourceTransaction.outputs[input.sourceOutputIndex].lockingScript)
          const r = new Utils.Reader(token.fields[1])
          const amount = String(r.readUInt64LEBn())
          const customFields = JSON.parse(Utils.toUTF8(token.fields[2]))
          const details = {
            tokenId: Utils.toUTF8(token.fields[0]),
            amount,
            customFields
          }
          console.log(`| in ${details.tokenId}\t|\t${amount}\t|`)

          const currentAmount = internalAssetBalances.get(details.tokenId)?.amount || 0

          if (details.tokenId === '___mint___') {
            // this is a mint so txid is the token outpoint
            internalAssetBalances.set(sourceTxid + '.' + input.sourceOutputIndex, { isMint: true, amount: currentAmount + Number(amount) })
          } else {
            internalAssetBalances.set(details.tokenId, { isMint: false, amount: currentAmount + Number(amount) })
          }

          coinsToRetain.push(index)
        } catch (err) {
          console.error(`Error processing input ${index}:`, err)
          // Continue with next input
        }
      }

      // Inspect every output
      for (const [index, output] of parsedTx.outputs.entries()) {
        try {
          if (output.lockingScript.chunks[1].op !== OP.OP_CHECKSIG) continue // because this isn't a token output
          const token = PushDrop.decode(output.lockingScript)
          const r = new Utils.Reader(token.fields[1])
          const amount = String(r.readUInt64LEBn())
          const customFields = JSON.parse(Utils.toUTF8(token.fields[2]))
          const details = {
            tokenId: Utils.toUTF8(token.fields[0]),
            amount,
            customFields
          }
          console.log(`| out ${details.tokenId}\t|\t${amount}\t|`)

          const currentAmount = internalAssetBalances.get(details.tokenId)?.amount || 0

          if (details.tokenId === '___mint___') {
            // this is a mint so txid is the token id
            internalAssetBalances.set(txid + '.' + String(index), { isMint: true, amount: currentAmount - Number(amount) })
          } else {
            internalAssetBalances.set(details.tokenId, { isMint: false, amount: currentAmount - Number(amount) })
          }

          outputsToAdmit.push(index)
        } catch (err) {
          console.info(`Could not process output ${index}:`, err)
          // Continue with next output
        }
      }

      console.log(internalAssetBalances)

      for (const [tokenId, balance] of internalAssetBalances.entries()) {
        if (balance.amount !== 0 && !balance.isMint) {
          console.error(`Unbalanced assets for non-mint token ${tokenId}`)
          return {
            outputsToAdmit: [],
            coinsToRetain: []
          }
        }
      }

      if (outputsToAdmit.length === 0) {
        throw new Error('TokenDemo topic manager: no outputs admitted!')
      }

      console.log(`Admitted ${outputsToAdmit.length} TokenDemo ${outputsToAdmit.length === 1 ? 'output' : 'outputs'}!`)
    } catch (err) {
      if (outputsToAdmit.length === 0 && (!previousCoins || previousCoins.length === 0)) {
        console.error('Error identifying admissible outputs:', err)
      }
    }

    // The TokenDemo protocol never retains previous coins
    return {
      outputsToAdmit,
      coinsToRetain: []
    }
  }

  /**
   * Get the documentation associated with this topic manager
   * @returns A promise that resolves to a string containing the documentation
   */
  async getDocumentation(): Promise<string> {
    return docs
  }

  /**
   * Get metadata about the topic manager
   * @returns A promise that resolves to an object containing metadata
   */
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
