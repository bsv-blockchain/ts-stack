import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { OP, Transaction, PushDrop, Utils } from '@bsv/sdk'

interface AssetBalance {
  amount: number
  isMint: boolean
}

function updateAssetBalance(
  balances: Map<string, AssetBalance>,
  lookupKey: string,
  storageKey: string,
  amountDelta: number,
  isMint: boolean
): void {
  const currentAmount = balances.get(lookupKey)?.amount || 0
  balances.set(storageKey, { isMint, amount: currentAmount + amountDelta })
}

function collectInputBalances(
  transaction: Transaction,
  previousCoins: number[],
  balances: Map<string, AssetBalance>
): void {
  for (const [index, input] of transaction.inputs.entries()) {
    if (!previousCoins.includes(index)) continue
    try {
      const sourceTransaction = input.sourceTransaction
      if (sourceTransaction === undefined) throw new Error('Missing source transaction')
      const sourceOutput = sourceTransaction.outputs[input.sourceOutputIndex]
      if (sourceOutput === undefined) throw new Error('Missing source output')
      const sourceTxid = sourceTransaction.id('hex')
      const token = PushDrop.decode(sourceOutput.lockingScript)
      const amount = Number(String(new Utils.Reader(token.fields[1]).readUInt64LEBn()))
      const tokenId = Utils.toUTF8(token.fields[0])
      JSON.parse(Utils.toUTF8(token.fields[2]))
      const isMint = tokenId === '___mint___'
      const storageKey = isMint ? `${sourceTxid}.${input.sourceOutputIndex}` : tokenId
      updateAssetBalance(balances, tokenId, storageKey, amount, isMint)
    } catch (error) {
      console.error(`Error processing input ${index}:`, error)
    }
  }
}

function collectAdmissibleOutputs(
  transaction: Transaction,
  balances: Map<string, AssetBalance>
): number[] {
  const outputsToAdmit: number[] = []
  const txid = transaction.id('hex')
  for (const [index, output] of transaction.outputs.entries()) {
    try {
      if (output.lockingScript.chunks[1].op !== OP.OP_CHECKSIG) continue
      const token = PushDrop.decode(output.lockingScript)
      const amount = Number(String(new Utils.Reader(token.fields[1]).readUInt64LEBn()))
      const tokenId = Utils.toUTF8(token.fields[0])
      JSON.parse(Utils.toUTF8(token.fields[2]))
      const isMint = tokenId === '___mint___'
      const storageKey = isMint ? `${txid}.${index}` : tokenId
      updateAssetBalance(balances, tokenId, storageKey, -amount, isMint)
      outputsToAdmit.push(index)
    } catch (error) {
      console.info(`Could not process output ${index}:`, error)
    }
  }
  return outputsToAdmit
}

function balancesAreValid(balances: Map<string, AssetBalance>): boolean {
  for (const [tokenId, balance] of balances.entries()) {
    if (balance.amount !== 0 && !balance.isMint) {
      console.error(`Unbalanced assets for non-mint token ${tokenId}`)
      return false
    }
  }
  return true
}

export default class TokenDemoTopicManager implements TopicManager {
  async identifyNeededInputs(
    beef: number[],
    _offChainValues?: number[]
  ): Promise<Array<{ txid: string; outputIndex: number }>> {
    console.log('identifyNeededInputs called')
    const tx = Transaction.fromBEEF(beef)

    if (!Array.isArray(tx.inputs) || tx.inputs.length === 0)
      throw new Error('Missing parameter: inputs')

    const previousOutpoints: Array<{ txid: string; outputIndex: number }> = []
    tx.inputs.forEach(input => {
      if (!input.sourceTransaction && input.sourceTXID !== undefined) {
        previousOutpoints.push({ txid: input.sourceTXID, outputIndex: input.sourceOutputIndex })
      }
    })
    return previousOutpoints
  }

  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    console.log({ previousCoins })
    const outputsToAdmit: number[] = []

    try {
      console.log('TokenDemo topic manager invoked')
      const parsedTx = Transaction.fromBEEF(beef)

      if (!Array.isArray(parsedTx.outputs) || parsedTx.outputs.length === 0) {
        throw new Error('Missing parameter: outputs')
      }

      const internalAssetBalances = new Map<string, AssetBalance>()
      collectInputBalances(parsedTx, previousCoins, internalAssetBalances)
      outputsToAdmit.push(...collectAdmissibleOutputs(parsedTx, internalAssetBalances))

      if (!balancesAreValid(internalAssetBalances)) return { outputsToAdmit: [], coinsToRetain: [] }
      if (outputsToAdmit.length === 0)
        throw new Error('TokenDemo topic manager: no outputs admitted!')
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
