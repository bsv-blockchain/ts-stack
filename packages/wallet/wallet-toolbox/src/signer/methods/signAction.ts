import {
  AtomicBEEF,
  Beef,
  SendWithResult,
  SignActionArgs,
  SignActionResult,
  TelemetrySpan,
  TXIDHexString,
  Validation
} from '@bsv/sdk'
import { processAction } from './createAction'
import { AuthId, ReviewActionResult } from '../../sdk/WalletStorage.interfaces'
import { completeSignedTransaction, verifyUnlockScripts } from './completeSignedTransaction'
import { Wallet } from '../../Wallet'
import { WERR_INTERNAL, WERR_NOT_IMPLEMENTED } from '../../sdk/WERR_errors'
import { setResultBeef } from './resultBeef'

export interface SignActionResultX extends SignActionResult {
  txid?: TXIDHexString
  tx?: AtomicBEEF
  sendWithResults?: SendWithResult[]
  notDelayedResults?: ReviewActionResult[]
}

export async function signAction(wallet: Wallet, auth: AuthId, args: SignActionArgs): Promise<SignActionResultX> {
  if (!wallet.telemetry.enabled) return await signActionCore(wallet, auth, args)
  return await wallet.telemetry.withSpan(
    'wallet.sign_action',
    {
      component: 'wallet-toolbox',
      carrier: args
    },
    async span => {
      const result = await signActionCore(wallet, auth, args, span)
      span.end({
        attributes: {
          'action.has_transaction': result.tx != null,
          'action.send_result_count': result.sendWithResults?.length ?? 0
        }
      })
      return result
    }
  )
}

async function signActionCore(
  wallet: Wallet,
  auth: AuthId,
  args: SignActionArgs,
  parent?: TelemetrySpan
): Promise<SignActionResultX> {
  const prior = wallet.pendingSignActions[args.reference]
  if (!prior) {
    throw new WERR_NOT_IMPLEMENTED('recovery of out-of-session signAction reference data is not yet implemented.')
  }
  if (prior.dcr.inputBeef == null) throw new WERR_INTERNAL('prior.dcr.inputBeef must be valid')

  const vargs = mergePriorOptions(prior.args, args)

  prior.tx = await traceSignActionStep(
    wallet,
    'wallet.sign_action.complete_signing',
    parent,
    async () => await completeSignedTransaction(prior, vargs.spends, wallet)
  )

  const { sendWithResults, notDelayedResults } = await traceSignActionStep(
    wallet,
    'wallet.sign_action.process',
    parent,
    async () => await processAction(prior, wallet, auth, vargs)
  )

  const txid = prior.tx.id('hex')
  const beef =
    prior.dcr.inputBeef instanceof Uint8Array
      ? Beef.fromBinaryView(prior.dcr.inputBeef)
      : Beef.fromBinary(prior.dcr.inputBeef)
  beef.mergeTransaction(prior.tx)

  await traceSignActionStep(
    wallet,
    'wallet.sign_action.verify_unlock_scripts',
    parent,
    async () => await verifyUnlockScripts(txid, beef, wallet.scriptVerifier)
  )

  const r: SignActionResultX = {
    txid: prior.tx.id('hex'),
    tx: vargs.options.returnTXIDOnly ? undefined : beef.toUint8ArrayAtomic(txid),
    sendWithResults,
    notDelayedResults
  }

  beef.atomicTxid = txid
  setResultBeef(r, beef)

  return r
}

async function traceSignActionStep<T>(
  wallet: Wallet,
  name: string,
  parent: TelemetrySpan | undefined,
  callback: () => Promise<T> | T
): Promise<T> {
  if (parent == null) return await callback()
  return await wallet.telemetry.withSpan(
    name,
    {
      component: 'wallet-toolbox',
      parent: parent.context
    },
    callback
  )
}

function mergePriorOptions(
  caVargs: Validation.ValidCreateActionArgs,
  saArgs: SignActionArgs
): Validation.ValidSignActionArgs {
  const saOptions = (saArgs.options ||= {})
  saOptions.acceptDelayedBroadcast ??= caVargs.options.acceptDelayedBroadcast
  saOptions.returnTXIDOnly ??= caVargs.options.returnTXIDOnly
  saOptions.noSend ??= caVargs.options.noSend
  saOptions.sendWith ??= caVargs.options.sendWith
  return Validation.validateSignActionArgs(saArgs)
}
