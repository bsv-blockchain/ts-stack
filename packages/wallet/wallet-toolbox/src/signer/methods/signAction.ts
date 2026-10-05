import {
  type ValidCreateActionArgs,
  type ValidSignActionArgs,
  validateSignActionArgs
} from '@bsv/sdk/wallet/validationHelpers'
import {
  AtomicBEEF,
  Beef,
  SendWithResult,
  SignActionArgs,
  SignActionResult,
  TelemetrySpan,
  TXIDHexString
} from '@bsv/sdk'
import { processAction, serializeResultBeef } from './createAction'
import { AuthId, ReviewActionResult } from '../../sdk/WalletStorage.interfaces'
import { completeSignedTransaction, verifyUnlockScripts } from './completeSignedTransaction'
import { Wallet } from '../../Wallet'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER, WERR_NOT_IMPLEMENTED } from '../../sdk/WERR_errors'
import { setResultBeef } from './resultBeef'
import type { Brc177ValidCreateActionArgs } from '../../utility/brc177NoSendExpiry'

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
      : Beef.fromBinaryStrict(prior.dcr.inputBeef)
  beef.mergeTransaction(prior.tx)

  await traceSignActionStep(
    wallet,
    'wallet.sign_action.verify_unlock_scripts',
    parent,
    async () => await verifyUnlockScripts(txid, beef, wallet.scriptVerifier)
  )

  const r: SignActionResultX = {
    txid: prior.tx.id('hex'),
    // knownTxids lives on the ORIGINAL createAction args: mergePriorOptions does not carry it
    // across, and ValidSignActionArgs has no field for it. Without this the declaration is
    // honoured when createAction returns the transaction and silently dropped when signAction
    // does -- and signAction is the path a wallet takes whenever the user approves a payment
    // before it is signed, which is every BRC-105 payment made from an interactive wallet.
    tx: vargs.options.returnTXIDOnly
      ? undefined
      : serializeResultBeef(beef, txid, prior.args.options.knownTxids),
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

function mergePriorOptions(caVargs: ValidCreateActionArgs, saArgs: SignActionArgs): ValidSignActionArgs {
  const saOptions = (saArgs.options ||= {})
  saOptions.acceptDelayedBroadcast ??= caVargs.options.acceptDelayedBroadcast
  saOptions.returnTXIDOnly ??= caVargs.options.returnTXIDOnly
  saOptions.noSend ??= caVargs.options.noSend
  saOptions.sendWith ??= caVargs.options.sendWith
  if ((caVargs as Brc177ValidCreateActionArgs).brc177?.kind === 'protected') {
    if (saOptions.sendWith.length > 0) {
      throw new WERR_INVALID_PARAMETER('options.sendWith', 'empty for a BRC-177 protected action')
    }
    if (saOptions.returnTXIDOnly) {
      throw new WERR_INVALID_PARAMETER('options.returnTXIDOnly', 'false for a BRC-177 protected action')
    }
    saOptions.noSend = true
  }
  return validateSignActionArgs(saArgs)
}
