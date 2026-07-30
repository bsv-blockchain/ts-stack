import { SignActionSpend, Transaction } from '@bsv/sdk'
import { PendingSignAction, Wallet } from '../../Wallet'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { asBsvSdkScript } from '../../utility/utilityHelpers'
import { ScriptTemplateBRC29 } from '../../utility/ScriptTemplateBRC29'

export async function completeSignedTransaction(
  prior: PendingSignAction,
  spends: Record<number, SignActionSpend>,
  wallet: Wallet
): Promise<Transaction> {
  /// //////////////////
  // Insert the user provided unlocking scripts from "spends" arg
  /// //////////////////
  for (const [key, spend] of Object.entries(spends)) {
    const vin = Number(key)
    const createInput = prior.args.inputs[vin]
    const input = prior.tx.inputs[vin]
    if (!createInput || !input || createInput.unlockingScript || !Number.isInteger(createInput.unlockingScriptLength)) {
      throw new WERR_INVALID_PARAMETER(
        'args',
        'spend does not correspond to prior input with valid unlockingScriptLength.'
      )
    }
    if (spend.unlockingScript.length / 2 > createInput.unlockingScriptLength) {
      throw new WERR_INVALID_PARAMETER(
        'args',
        `spend unlockingScript length ${spend.unlockingScript.length} exceeds expected length ${createInput.unlockingScriptLength}`
      )
    }
    input.unlockingScript = asBsvSdkScript(spend.unlockingScript)
    if (spend.sequenceNumber !== undefined) input.sequence = spend.sequenceNumber
  }

  /// //////////////////
  // Insert SABPPP unlock templates for wallet signed inputs
  /// //////////////////
  for (const pdi of prior.pdi) {
    const sabppp = new ScriptTemplateBRC29({
      derivationPrefix: pdi.derivationPrefix,
      derivationSuffix: pdi.derivationSuffix,
      keyDeriver: wallet.keyDeriver
    })
    const keys = wallet.getClientChangeKeyPair()
    const lockerPrivKey = keys.privateKey
    const unlockerPubKey = pdi.unlockerPubKey || keys.publicKey
    const sourceSatoshis = pdi.sourceSatoshis
    const lockingScript = asBsvSdkScript(pdi.lockingScript)
    const unlockTemplate = sabppp.unlock(lockerPrivKey, unlockerPubKey, sourceSatoshis, lockingScript)
    const input = prior.tx.inputs[pdi.vin]
    input.unlockingScriptTemplate = unlockTemplate
  }

  /// //////////////////
  // Sign wallet signed inputs making transaction fully valid.
  /// //////////////////
  if (wallet.telemetry.enabled) {
    await wallet.telemetry.withSpan(
      'wallet.crypto.transaction_sign',
      {
        component: 'wallet-toolbox',
        carrier: prior.args,
        attributes: {
          'crypto.input_count': prior.tx.inputs.length
        }
      },
      async () => await prior.tx.sign()
    )
  } else {
    await prior.tx.sign()
  }

  return prior.tx
}

export { verifyUnlockScripts } from './verifyUnlockScripts'
export type { UnlockScriptVerificationResult } from './verifyUnlockScripts'
