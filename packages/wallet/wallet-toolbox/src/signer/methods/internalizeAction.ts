import { Beef, InternalizeActionArgs, InternalizeOutput, P2PKH, WalletProtocol, Validation } from '@bsv/sdk'
import { Wallet } from '../../Wallet'
import { AuthId, StorageInternalizeActionResult } from '../../sdk/WalletStorage.interfaces'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

/**
 * Internalize Action allows a wallet to take ownership of outputs in a pre-existing transaction.
 * The transaction may, or may not already be known to both the storage and user.
 *
 * Two types of outputs are handled: "wallet payments" and "basket insertions".
 *
 * A "basket insertion" output is considered a custom output and has no effect on the wallet's "balance".
 *
 * A "wallet payment" adds an outputs value to the wallet's change "balance". These outputs are assigned to the "default" basket.
 *
 * Processing starts with simple validation and then checks for a pre-existing transaction.
 * If the transaction is already known to the user, then the outputs are reviewed against the existing outputs treatment,
 * and merge rules are added to the arguments passed to the storage layer.
 *
 * The existing transaction's `status` determines what the merge path does next:
 *  - `'unproven'`, `'completed'`, or `'sending'`: outputs are merged; status is left as-is.
 *    The `'sending'` case covers a transaction this wallet already signed and handed to broadcast processing, but
 *    whose proven_tx_req has not yet been advanced by the normal monitor/posting flow.
 *  - `'nosend'`: the `internalizeAction` call is treated as explicit authorization to advance the lifecycle.
 *    `transactions.status` is promoted to `'completed'` (BUMP-bearing BEEF) or `'unproven'` (otherwise), and the
 *    `proven_tx_req` is moved out of `'nosend'` so Monitor's proof-fetching flow can finalize it. See storage-layer
 *    `internalizeAction` docs for the full rationale.
 *  - Any other status: an error.
 *
 * When the transaction already exists, the description is updated. The isOutgoing sense is not changed.
 *
 * "basket insertion" Merge Rules:
 * 1. The "default" basket may not be specified as the insertion basket.
 * 2. Managed change may not be reclassified as a basket insertion.
 * 3. Basket insertions do not affect wallet balance and are typed "custom".
 *
 * "wallet payment" Merge Rules:
 * 1. Targeting an existing managed output is idempotent.
 * 2. Targeting a custom output converts it to managed BRC-29 change after
 *    the locking script is verified. This is the only supported in-place
 *    recovery path for a misclassified BRC-29 payment.
 *
 */
export async function internalizeAction(
  wallet: Wallet,
  auth: AuthId,
  args: InternalizeActionArgs
): Promise<StorageInternalizeActionResult> {
  const vargs = Validation.validateInternalizeActionArgs(args)

  const { tx } = await validateAtomicBeef()
  const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']

  for (const o of vargs.outputs) {
    if (o.outputIndex < 0 || o.outputIndex >= tx.outputs.length) {
      throw new WERR_INVALID_PARAMETER('outputIndex', `a valid output index in range 0 to ${tx.outputs.length - 1}`)
    }
    switch (o.protocol) {
      case 'basket insertion':
        setupBasketInsertionForOutput(o, vargs)
        break
      case 'wallet payment':
        setupWalletPaymentForOutput(o, vargs)
        break
      default:
        throw new WERR_INTERNAL(`unexpected protocol ${o.protocol}`)
    }
  }

  const r: StorageInternalizeActionResult = await wallet.storage.internalizeAction(args)

  return r

  function setupWalletPaymentForOutput(o: InternalizeOutput, _dargs: Validation.ValidInternalizeActionArgs) {
    const p = o.paymentRemittance
    const output = tx.outputs[o.outputIndex]
    if (p == null) throw new WERR_INVALID_PARAMETER('paymentRemittance', `valid for protocol ${o.protocol}`)

    const keyID = `${p.derivationPrefix} ${p.derivationSuffix}`

    const privKey = wallet.keyDeriver.derivePrivateKey(brc29ProtocolID, keyID, p.senderIdentityKey)
    const expectedLockScript = new P2PKH().lock(privKey.toAddress())
    if (output.lockingScript.toHex() !== expectedLockScript.toHex()) {
      throw new WERR_INVALID_PARAMETER('paymentRemittance', 'locked by script conforming to BRC-29')
    }
  }

  function setupBasketInsertionForOutput(o: InternalizeOutput, _dargs: Validation.ValidInternalizeActionArgs) {
    const insertion = o.insertionRemittance
    if (insertion == null) throw new WERR_INVALID_PARAMETER('insertionRemittance', `valid for protocol ${o.protocol}`)
    if (insertion.basket === 'default') {
      throw new WERR_INVALID_PARAMETER('insertionRemittance.basket', 'a non-default basket')
    }
  }

  /**
   * Verifies that the `tx` argument passed to internalizeAction is a valid AtomicBEEF,
   * and the proofs are valid according to the wallet's configured chainTracker.
   * THIS DOES NOT GUARANTEE:
   * 1. That the transaction has been broadcast. (Is known to the network).
   * 2. That the proofs are for the same block as recorded in the wallet's configured storage in the event of a reorg.
   */
  async function validateAtomicBeef() {
    const ab = Beef.fromBinary(vargs.tx)

    // TODO: Add support for known txids...which would speed up processing by avoiding a network call,
    // unless a local chaintracker is used.

    const txValid = await ab.verify(await wallet.getServices().getChainTracker(), false)
    if (!txValid || !ab.atomicTxid) {
      console.log(`internalizeAction beef is invalid: ${ab.toLogString()}`)
      throw new WERR_INVALID_PARAMETER('tx', 'valid AtomicBEEF')
    }
    const txid = ab.atomicTxid
    const btx = ab.findTxid(txid)
    if (btx == null) throw new WERR_INVALID_PARAMETER('tx', `valid AtomicBEEF with newest txid of ${txid}`)
    const tx = btx.tx!

    return { ab, tx, txid }
  }
}
