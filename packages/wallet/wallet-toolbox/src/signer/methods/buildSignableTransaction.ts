import { Beef, Script, Transaction, Validation } from '@bsv/sdk'
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
import { maxPossibleSatoshis } from '../../storage/methods/generateChange'

export function buildSignableTransaction(
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

  const inputBeef = args.inputBEEF != null ? Beef.fromBinary(args.inputBEEF) : undefined

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
  addPlannedOutputs(tx, storageOutputs, dctr, args, changeKeys, wallet)

  const pendingStorageInputs: PendingStorageInput[] = []
  const totalChangeInputs = addPlannedInputs(
    tx,
    storageInputs,
    args,
    inputBeef,
    pendingStorageInputs
  )

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

function outputIndexByVout(storageOutputs: StorageCreateTransactionSdkOutput[]): number[] {
  return Array.from({ length: storageOutputs.length }, (_, vout) => {
    const index = storageOutputs.findIndex(output => output.vout === vout)
    if (index < 0) {
      throw new WERR_INVALID_PARAMETER('output.vout', `sequential. ${vout} is missing`)
    }
    return index
  })
}

function addPlannedOutputs(
  tx: Transaction,
  storageOutputs: StorageCreateTransactionSdkOutput[],
  dctr: StorageCreateActionResult,
  args: Validation.ValidCreateActionArgs,
  changeKeys: KeyPair,
  wallet: Wallet
): void {
  // Storage preserves request/commission/change array order while `vout` may
  // randomize the final transaction order.
  for (const [vout, index] of outputIndexByVout(storageOutputs).entries()) {
    const output = storageOutputs[index]
    if (vout !== output.vout) {
      throw new WERR_INVALID_PARAMETER(
        'output.vout',
        `equal to array index. ${output.vout} !== ${vout}`
      )
    }
    const change = output.providedBy === 'storage' && output.purpose === 'change'
    tx.addOutput({
      satoshis: output.satoshis,
      lockingScript: change
        ? makeChangeLock(output, dctr, args, changeKeys, wallet)
        : asBsvSdkScript(output.lockingScript),
      change
    })
  }
  if (storageOutputs.length === 0) {
    tx.addOutput({
      satoshis: 0,
      lockingScript: Script.fromASM('OP_FALSE OP_RETURN 42'),
      change: false
    })
  }
}

function addRequestedInput(
  tx: Transaction,
  argsInput: Validation.ValidCreateActionInput,
  args: Validation.ValidCreateActionArgs,
  inputBeef: Beef | undefined
): void {
  const unlockingScript =
    typeof argsInput.unlockingScript === 'string'
      ? asBsvSdkScript(argsInput.unlockingScript)
      : new Script()
  tx.addInput({
    sourceTXID: argsInput.outpoint.txid,
    sourceOutputIndex: argsInput.outpoint.vout,
    sourceTransaction: args.isSignAction
      ? inputBeef?.findTxid(argsInput.outpoint.txid)?.tx
      : undefined,
    unlockingScript,
    sequence: argsInput.sequenceNumber
  })
}

function sourceTransactionForStorageInput(
  storageInput: StorageCreateTransactionSdkInput
): Transaction | undefined {
  if (storageInput.sourceTransaction == null) return undefined
  return storageInput.sourceTransaction instanceof Uint8Array
    ? Transaction.fromBinaryView(storageInput.sourceTransaction)
    : Transaction.fromBinary(storageInput.sourceTransaction)
}

function addStorageInput(
  tx: Transaction,
  storageInput: StorageCreateTransactionSdkInput,
  pendingStorageInputs: PendingStorageInput[]
): number {
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
  tx.addInput({
    sourceTXID: storageInput.sourceTxid,
    sourceOutputIndex: storageInput.sourceVout,
    sourceTransaction: sourceTransactionForStorageInput(storageInput),
    unlockingScript: new Script(),
    sequence: 0xffffffff
  })
  return Validation.validateSatoshis(
    storageInput.sourceSatoshis,
    'storageInput.sourceSatoshis'
  )
}

function addPlannedInputs(
  tx: Transaction,
  storageInputs: StorageCreateTransactionSdkInput[],
  args: Validation.ValidCreateActionArgs,
  inputBeef: Beef | undefined,
  pendingStorageInputs: PendingStorageInput[]
): number {
  const inputs = storageInputs
    .map(storageInput => ({
      storageInput,
      argsInput:
        storageInput.vin < args.inputs.length
          ? args.inputs[storageInput.vin]
          : undefined
    }))
    .sort((left, right) => left.storageInput.vin - right.storageInput.vin)

  let totalChangeInputs = 0
  for (const { storageInput, argsInput } of inputs) {
    if (argsInput != null) {
      addRequestedInput(tx, argsInput, args, inputBeef)
      continue
    }
    totalChangeInputs += addStorageInput(tx, storageInput, pendingStorageInputs)
  }
  return totalChangeInputs
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
export function verifyRequestedOutputsUnchanged(
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

    if (requested.satoshis !== maxPossibleSatoshis && provided.satoshis !== requested.satoshis) {
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
export function verifyUnrequestedOutputsAreChangeOrCommission(
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
export function makeChangeLock(
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
