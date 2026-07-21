import { Beef, Script, Transaction, TransactionInput, TransactionOutput, Validation } from '@bsv/sdk'
import { Wallet, PendingStorageInput } from '../../Wallet'
import {
  StorageCreateActionResult,
  StorageCreateTransactionSdkInput,
  StorageCreateTransactionSdkOutput
} from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { asBsvSdkScript, verifyTruthy } from '../../utility/utilityHelpers'
import { KeyPair } from '../../sdk/types'
import { ScriptTemplateBRC29 } from '../../utility/ScriptTemplateBRC29'

export function buildSignableTransaction (
  dctr: StorageCreateActionResult,
  args: Validation.ValidCreateActionArgs,
  wallet: Wallet
): {
    tx: Transaction
    amount: number
    pdi: PendingStorageInput[]
    log: string
  } {
  const changeKeys = wallet.getClientChangeKeyPair()

  const inputBeef = (args.inputBEEF != null) ? Beef.fromBinary(args.inputBEEF) : undefined

  const { inputs: storageInputs, outputs: storageOutputs } = dctr

  // SECURITY (GHSA-36f9-7rg5-cpf8): The locking scripts used to build and sign
  // the transaction are taken from the storage response. When storage is remote
  // (StorageClient, the default configuration), a malicious or compromised
  // storage operator could return a different recipient script than the caller
  // requested; it would be signed and broadcast while the calling app/UI still
  // shows the originally requested recipient. Verify that every caller-specified
  // output is echoed back by storage unchanged before anything is signed.
  verifyRequestedOutputsUnchanged(storageOutputs, args)

  // SECURITY (GHSA-36f9-7rg5-cpf8): verifyRequestedOutputsUnchanged only protects
  // the caller's own outputs. Storage could instead inject an ADDITIONAL output
  // paying an attacker (funded by reducing change), which the loop below signs
  // verbatim. Every output beyond the caller's must be either a change output
  // (script re-derived client-side, so it can only pay the client) or the single
  // bounded commission output. Anything else is rejected before signing.
  verifyUnrequestedOutputsAreChangeOrCommission(storageOutputs, args)

  const tx = new Transaction(args.version, [], [], args.lockTime)

  // The order of outputs in storageOutputs is always:
  // CreateActionArgs.outputs in the original order
  // Commission output
  // Change outputs
  // The Vout values will be randomized if args.options.randomizeOutputs is true. Default is true.
  const voutToIndex = new Array<number>(storageOutputs.length)
  for (let vout = 0; vout < storageOutputs.length; vout++) {
    const i = storageOutputs.findIndex(o => o.vout === vout)
    if (i < 0) throw new WERR_INVALID_PARAMETER('output.vout', `sequential. ${vout} is missing`)
    voutToIndex[vout] = i
  }

  /// ///////////
  // Add OUTPUTS
  /// //////////
  for (let vout = 0; vout < storageOutputs.length; vout++) {
    const i = voutToIndex[vout]
    const out = storageOutputs[i]
    if (vout !== out.vout) { throw new WERR_INVALID_PARAMETER('output.vout', `equal to array index. ${out.vout} !== ${vout}`) }

    const change = out.providedBy === 'storage' && out.purpose === 'change'

    const lockingScript = change
      ? makeChangeLock(out, dctr, args, changeKeys, wallet)
      : asBsvSdkScript(out.lockingScript)

    const output: TransactionOutput = {
      satoshis: out.satoshis,
      lockingScript,
      change
    }
    tx.addOutput(output)
  }

  if (storageOutputs.length === 0) {
    // Add a dummy output to avoid transaction rejection by processors for having no outputs.
    const output: TransactionOutput = {
      satoshis: 0,
      lockingScript: Script.fromASM('OP_FALSE OP_RETURN 42'),
      change: false
    }
    tx.addOutput(output)
  }

  /// ///////////
  // Merge and sort INPUTS info by vin order.
  /// //////////
  const inputs: Array<{
    argsInput: Validation.ValidCreateActionInput | undefined
    storageInput: StorageCreateTransactionSdkInput
  }> = []
  for (const storageInput of storageInputs) {
    const argsInput =
      storageInput.vin !== undefined && storageInput.vin < args.inputs.length
        ? args.inputs[storageInput.vin]
        : undefined
    inputs.push({ argsInput, storageInput })
  }
  inputs.sort((a, b) => {
    if (a.storageInput.vin < b.storageInput.vin) return -1
    if (a.storageInput.vin === b.storageInput.vin) return 0
    return 1
  })

  const pendingStorageInputs: PendingStorageInput[] = []

  /// ///////////
  // Add INPUTS
  /// //////////
  let totalChangeInputs = 0
  for (const { storageInput, argsInput } of inputs) {
    // Two types of inputs are handled: user specified wth/without unlockingScript and storage specified using SABPPP template.
    if (argsInput != null) {
      // Type 1: User supplied input, with or without an explicit unlockingScript.
      // If without, signAction must be used to provide the actual unlockScript.
      const unlock =
        typeof argsInput.unlockingScript === 'string' ? asBsvSdkScript(argsInput.unlockingScript) : new Script()
      const sourceTransaction = args.isSignAction ? inputBeef?.findTxid(argsInput.outpoint.txid)?.tx : undefined
      const inputToAdd: TransactionInput = {
        sourceTXID: argsInput.outpoint.txid,
        sourceOutputIndex: argsInput.outpoint.vout,
        // Include the source transaction for access to the outputs locking script and output satoshis for user side fee calculation.
        // TODO: Make this conditional to improve performance when user can supply locking scripts themselves.
        sourceTransaction,
        unlockingScript: unlock,
        sequence: argsInput.sequenceNumber
      }
      tx.addInput(inputToAdd)
    } else {
      // Type2: SABPPP protocol inputs which are signed using ScriptTemplateBRC29.
      if (storageInput.type !== 'P2PKH') {
        throw new WERR_INVALID_PARAMETER(
          'type',
          `vin ${storageInput.vin}, "${storageInput.type}" is not a supported unlocking script type.`
        )
      }

      pendingStorageInputs.push({
        vin: tx.inputs.length,
        derivationPrefix: verifyTruthy(storageInput.derivationPrefix),
        derivationSuffix: verifyTruthy(storageInput.derivationSuffix),
        unlockerPubKey: storageInput.senderIdentityKey,
        sourceSatoshis: storageInput.sourceSatoshis,
        lockingScript: storageInput.sourceLockingScript
      })

      const inputToAdd: TransactionInput = {
        sourceTXID: storageInput.sourceTxid,
        sourceOutputIndex: storageInput.sourceVout,
        sourceTransaction: (storageInput.sourceTransaction != null)
          ? storageInput.sourceTransaction instanceof Uint8Array
            ? Transaction.fromBinaryView(storageInput.sourceTransaction)
            : Transaction.fromBinary(storageInput.sourceTransaction)
          : undefined,
        unlockingScript: new Script(),
        sequence: 0xffffffff
      }
      tx.addInput(inputToAdd)
      totalChangeInputs += Validation.validateSatoshis(storageInput.sourceSatoshis, 'storageInput.sourceSatoshis')
    }
  }

  // The amount is the total of non-foreign inputs minus change outputs
  // Note that the amount can be negative when we are redeeming more inputs than we are spending
  const totalChangeOutputs = storageOutputs
    .filter(x => x.purpose === 'change')
    .reduce((acc, el) => acc + el.satoshis, 0)
  const amount = totalChangeInputs - totalChangeOutputs

  return {
    tx,
    amount,
    pdi: pendingStorageInputs,
    log: ''
  }
}

/**
 * Verify that the outputs returned by storage for caller-specified outputs match
 * exactly what the caller requested in `args.outputs`.
 *
 * The storage response (`StorageCreateActionResult.outputs`) is ordered, by
 * contract, as: the caller's `args.outputs` in their original order, followed by
 * the optional commission output, followed by storage-provided change outputs.
 * Only the `vout` field is randomized when `randomizeOutputs` is set; the array
 * order is stable. Therefore array index `i` (for `i < args.outputs.length`)
 * corresponds to `args.outputs[i]`.
 *
 * Because the locking script that is ultimately signed is taken from the storage
 * response, an untrusted storage provider must not be allowed to alter the
 * recipient script (or amount) of a caller-specified output. Any mismatch is a
 * hard error. (GHSA-36f9-7rg5-cpf8)
 *
 * @throws WERR_INVALID_PARAMETER if storage omitted, reclassified, or modified
 *   any caller-specified output.
 */
export function verifyRequestedOutputsUnchanged (
  storageOutputs: StorageCreateTransactionSdkOutput[],
  args: Validation.ValidCreateActionArgs
): void {
  for (let i = 0; i < args.outputs.length; i++) {
    const requested = args.outputs[i]
    const provided = storageOutputs[i]

    if (provided == null) {
      throw new WERR_INVALID_PARAMETER(
        'storage outputs',
        `present for every requested output. Storage did not return an output for requested output index ${i}.`
      )
    }

    // A caller-specified output must never be reclassified by storage as change
    // or as storage-provided; doing so would route it through makeChangeLock and
    // bypass the script comparison below.
    if (provided.purpose === 'change' || provided.providedBy === 'storage') {
      throw new WERR_INVALID_PARAMETER(
        'output.providedBy',
        `consistent with the request. Storage reclassified requested output ${i} as providedBy='${provided.providedBy}' purpose='${provided.purpose ?? ''}'.`
      )
    }

    const requestedScript = (requested.lockingScript ?? '').toLowerCase()
    const providedScript = (typeof provided.lockingScript === 'string' ? provided.lockingScript : '').toLowerCase()
    if (requestedScript.length === 0 || requestedScript !== providedScript) {
      throw new WERR_INVALID_PARAMETER(
        'output.lockingScript',
        `equal to the caller-requested locking script. Storage returned a different locking script for output index ${i}; the recipient may have been substituted.`
      )
    }

    if (provided.satoshis !== requested.satoshis) {
      throw new WERR_INVALID_PARAMETER(
        'output.satoshis',
        `equal to the caller-requested satoshis. Storage returned ${provided.satoshis} for output index ${i}, caller requested ${requested.satoshis}.`
      )
    }
  }
}

/**
 * Default ceiling for a storage-provided commission (service-charge) output, in
 * satoshis. The commission is the one output whose locking script is taken
 * verbatim from storage and cannot be re-derived or verified client-side, so a
 * malicious storage operator could point it at an attacker address. Capping it
 * bounds the worst-case loss from that single output; honest commissions are far
 * below this. (GHSA-36f9-7rg5-cpf8)
 */
export const MAX_STORAGE_COMMISSION_SATOSHIS = 500000

/**
 * Verify that every storage output beyond the caller's requested outputs is
 * either a change output or the (single, bounded) commission output.
 *
 * The storage response is ordered `[caller outputs][commission?][change...]`;
 * `verifyRequestedOutputsUnchanged` already validates the caller region (indices
 * `< args.outputs.length`). This checks the remainder.
 *
 * Change outputs (`providedBy: 'storage', purpose: 'change'`) are safe at any
 * amount: `buildSignableTransaction` ignores the storage-supplied script and
 * re-derives it client-side (`makeChangeLock` / BRC-29 under the client's own
 * change key), so a change output can only ever pay the client. A change output
 * mislabeled by storage is therefore harmless.
 *
 * The commission output's script, by contrast, is taken verbatim from storage
 * and cannot be verified client-side. A malicious storage could inject an extra
 * output — or relabel one as commission — to redirect funds to an attacker while
 * the caller/UI only sees the requested recipients. To bound that, at most one
 * commission output is allowed and its amount must not exceed `maxCommission`.
 * Any other unrecognized output is rejected outright.
 *
 * @throws WERR_INVALID_PARAMETER if storage returned an unrecognized output, more
 *   than one commission output, or a commission exceeding `maxCommission`.
 */
export function verifyUnrequestedOutputsAreChangeOrCommission (
  storageOutputs: StorageCreateTransactionSdkOutput[],
  args: Validation.ValidCreateActionArgs,
  maxCommission: number = MAX_STORAGE_COMMISSION_SATOSHIS
): void {
  let commissionCount = 0
  for (let i = args.outputs.length; i < storageOutputs.length; i++) {
    const out = storageOutputs[i]
    const isChange = out.providedBy === 'storage' && out.purpose === 'change'
    if (isChange) continue

    // Honest storage remaps a service-charge to purpose 'storage-commission';
    // accept the pre-remap label too so the check is robust across versions.
    const isCommission =
      out.providedBy === 'storage' && (out.purpose === 'storage-commission' || out.purpose === 'service-charge')
    if (isCommission) {
      commissionCount++
      if (commissionCount > 1) {
        throw new WERR_INVALID_PARAMETER(
          'storage outputs',
          `at most one commission output. Storage returned an extra commission output at index ${i}.`
        )
      }
      if (out.satoshis > maxCommission) {
        throw new WERR_INVALID_PARAMETER(
          'output.satoshis',
          `a commission no greater than ${maxCommission}. Storage returned a commission of ${out.satoshis} at index ${i}; funds could be redirected to an attacker.`
        )
      }
      continue
    }

    throw new WERR_INVALID_PARAMETER(
      'storage outputs',
      'only change or commission beyond the requested outputs. Storage returned an unrecognized output ' +
        `(providedBy='${out.providedBy}' purpose='${out.purpose ?? ''}') at index ${i}; funds could be redirected to an attacker.`
    )
  }
}

/**
 * Derive a change output locking script
 */
export function makeChangeLock (
  out: StorageCreateTransactionSdkOutput,
  dctr: StorageCreateActionResult,
  args: Validation.ValidCreateActionArgs,
  changeKeys: KeyPair,
  wallet: Wallet
): Script {
  const derivationPrefix = dctr.derivationPrefix
  const derivationSuffix = verifyTruthy(out.derivationSuffix)
  const sabppp = new ScriptTemplateBRC29({
    derivationPrefix,
    derivationSuffix,
    keyDeriver: wallet.keyDeriver
  })
  const lockingScript = sabppp.lock(changeKeys.privateKey, changeKeys.publicKey)
  return lockingScript
}
