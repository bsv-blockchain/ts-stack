import { AdmittanceInstructions } from '@bsv/overlay'
import { LockingScript, Transaction } from '@bsv/sdk'
import { assertTransactionInputsAndOutputs } from './assertTransactionShape.js'

interface IdentifyPushDropOutputsOptions {
  beef: number[]
  previousCoins: number[] | undefined
  validateOutput: (lockingScript: LockingScript) => Promise<void>
  onRejectedOutput: (outputIndex: number, error: unknown) => void
}

export async function identifyPushDropOutputs({
  beef,
  previousCoins,
  validateOutput,
  onRejectedOutput
}: IdentifyPushDropOutputsOptions): Promise<AdmittanceInstructions> {
  const outputsToAdmit: number[] = []
  try {
    const parsedTransaction = Transaction.fromBEEF(beef)
    assertTransactionInputsAndOutputs(parsedTransaction)

    for (const [outputIndex, output] of parsedTransaction.outputs.entries()) {
      try {
        await validateOutput(output.lockingScript)
        outputsToAdmit.push(outputIndex)
      } catch (error) {
        onRejectedOutput(outputIndex, error)
      }
    }

    if (outputsToAdmit.length === 0) throw new Error('No outputs admitted!')
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
