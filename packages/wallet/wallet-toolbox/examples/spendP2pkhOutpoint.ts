import { Beef, PrivateKey, SignActionResult } from '@bsv/sdk'
import { Setup, Wallet } from '../out/src/index.js'

export interface P2pkhSpendInput {
  inputBeef: number[] | Uint8Array
  outpoint: `${string}.${number}`
  privateKey: PrivateKey
  satoshis: number
}

/**
 * Spend one explicitly supplied P2PKH outpoint through a configured Wallet.
 *
 * The caller retrieves and validates the source BEEF, selects the network,
 * and supplies the private key. This example never loads credentials or
 * hard-coded funded outpoints.
 */
export async function spendP2pkhOutpoint(wallet: Wallet, input: P2pkhSpendInput): Promise<SignActionResult> {
  const description = 'spend external P2PKH outpoint'
  const action = await wallet.createAction({
    inputBEEF: input.inputBeef,
    inputs: [
      {
        outpoint: input.outpoint,
        unlockingScriptLength: 108,
        inputDescription: description
      }
    ],
    labels: [description],
    description
  })
  if (action.signableTransaction === undefined) {
    throw new Error('Wallet did not return a signable transaction')
  }

  const signable = action.signableTransaction
  const beef = Beef.fromBinary(signable.tx)
  const transaction = beef.findAtomicTransaction(beef.txs[beef.txs.length - 1].txid)
  if (transaction === undefined || transaction.inputs.length !== 1) {
    throw new Error('Signable transaction did not contain the expected input')
  }
  transaction.inputs[0].unlockingScriptTemplate = Setup.getUnlockP2PKH(input.privateKey, input.satoshis)
  await transaction.sign()
  const unlockingScript = transaction.inputs[0].unlockingScript
  if (unlockingScript === undefined) {
    throw new Error('P2PKH input did not produce an unlocking script')
  }

  return await wallet.signAction({
    reference: signable.reference,
    spends: { 0: { unlockingScript: unlockingScript.toHex() } },
    options: { acceptDelayedBroadcast: false }
  })
}
