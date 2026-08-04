import { PublicKey, SignActionSpend, Transaction } from '@bsv/sdk'
import { PendingSignAction, Wallet } from '../../Wallet'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { asBsvSdkScript } from '../../utility/utilityHelpers'
import { brc29ProtocolID, ScriptTemplateBRC29 } from '../../utility/ScriptTemplateBRC29'

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
  const prepareUnlockingTemplates = (
    keys: ReturnType<Wallet['getClientChangeKeyPair']>
  ): void => {
    const counterparties = new Map<string, PublicKey>()
    const counterparty = (publicKey: string): PublicKey => {
      let parsed = counterparties.get(publicKey)
      if (parsed == null) {
        parsed = PublicKey.fromString(publicKey)
        counterparties.set(publicKey, parsed)
      }
      return parsed
    }
    const prepared = prior.pdi.map(pdi => {
      const template = new ScriptTemplateBRC29({
        derivationPrefix: pdi.derivationPrefix,
        derivationSuffix: pdi.derivationSuffix,
        keyDeriver: wallet.keyDeriver
      })
      const unlockerPubKey = counterparty(pdi.unlockerPubKey || keys.publicKey)
      return { pdi, template, unlockerPubKey }
    })
    const derivations = prepared.map(({ template, unlockerPubKey }) => ({
      protocolID: brc29ProtocolID,
      keyID: template.getKeyID(),
      counterparty: unlockerPubKey
    }))
    const derivedPrivateKeys = wallet.keyDeriver.derivePrivateKeys?.(derivations) ??
      derivations.map(derivation => wallet.keyDeriver.derivePrivateKey(
        derivation.protocolID,
        derivation.keyID,
        derivation.counterparty
      ))
    for (let index = 0; index < prepared.length; index++) {
      const { pdi, template } = prepared[index]
      const unlockTemplate = template.unlockWithDerivedPrivateKey(
        derivedPrivateKeys[index],
        pdi.sourceSatoshis,
        asBsvSdkScript(pdi.lockingScript)
      )
      const input = prior.tx.inputs[pdi.vin]
      input.unlockingScriptTemplate = unlockTemplate
    }
  }

  if (wallet.telemetry.enabled && prior.pdi.length > 0) {
    await wallet.telemetry.withSpan(
      'wallet.crypto.prepare_unlocking_templates',
      {
        component: 'wallet-toolbox',
        carrier: prior.args,
        attributes: {
          'crypto.managed_input_count': prior.pdi.length
        }
      },
      async span => {
        // Computing the root public key requires an elliptic-curve
        // multiplication. It is invariant for the complete action and must not
        // be repeated for every managed input in fragmented funding.
        const keys = await wallet.telemetry.withSpan(
          'wallet.crypto.client_change_key',
          { component: 'wallet-toolbox', parent: span.context },
          () => wallet.getClientChangeKeyPair()
        )
        await wallet.telemetry.withSpan(
          'wallet.crypto.derive_unlocking_templates',
          {
            component: 'wallet-toolbox',
            parent: span.context,
            attributes: { 'crypto.managed_input_count': prior.pdi.length }
          },
          () => prepareUnlockingTemplates(keys)
        )
      }
    )
  } else if (prior.pdi.length > 0) {
    prepareUnlockingTemplates(wallet.getClientChangeKeyPair())
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
