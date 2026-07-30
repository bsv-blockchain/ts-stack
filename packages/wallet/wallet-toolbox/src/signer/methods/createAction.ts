import {
  AtomicBEEF,
  Beef,
  CreateActionResult,
  OutpointString,
  SendWithResult,
  SignableTransaction,
  TelemetrySpan,
  TXIDHexString,
  Transaction,
  Validation
} from '@bsv/sdk'
import { buildSignableTransaction } from './buildSignableTransaction'
import {
  AuthId,
  ReviewActionResult,
  StorageProcessActionArgs,
  StorageProcessActionResults
} from '../../sdk/WalletStorage.interfaces'
import { completeSignedTransaction, verifyUnlockScripts } from './completeSignedTransaction'
import { PendingSignAction, Wallet } from '../../Wallet'
import { WERR_INTERNAL } from '../../sdk/WERR_errors'
import { setResultBeef } from './resultBeef'

export interface CreateActionResultX extends CreateActionResult {
  txid?: TXIDHexString
  tx?: AtomicBEEF
  noSendChange?: OutpointString[]
  sendWithResults?: SendWithResult[]
  signableTransaction?: SignableTransaction
  notDelayedResults?: ReviewActionResult[]
}

export async function createAction(
  wallet: Wallet,
  auth: AuthId,
  vargs: Validation.ValidCreateActionArgs
): Promise<CreateActionResultX> {
  if (!wallet.telemetry.enabled) return await createActionCore(wallet, auth, vargs)
  return await wallet.telemetry.withSpan(
    'wallet.create_action',
    {
      component: 'wallet-toolbox',
      carrier: vargs,
      attributes: {
        'action.input_count': vargs.inputs.length,
        'action.output_count': vargs.outputs.length,
        'action.is_new_transaction': vargs.isNewTx,
        'action.is_sign_action': vargs.isSignAction
      }
    },
    async span => {
      const result = await createActionCore(wallet, auth, vargs, span)
      span.end({
        attributes: {
          'action.has_transaction': result.tx != null,
          'action.has_signable_transaction': result.signableTransaction != null,
          'action.send_result_count': result.sendWithResults?.length ?? 0
        }
      })
      return result
    }
  )
}

async function createActionCore(
  wallet: Wallet,
  auth: AuthId,
  vargs: Validation.ValidCreateActionArgs,
  parent?: TelemetrySpan
): Promise<CreateActionResultX> {
  const r: CreateActionResultX = {}
  const logger = vargs.logger

  let prior: PendingSignAction | undefined

  if (vargs.isNewTx || vargs.isTestWerrReviewActions) {
    prior = await createNewTx(wallet, vargs, parent)
    logger?.log('created new transaction')

    if (vargs.isSignAction) {
      const r = makeSignableTransactionResult(prior, wallet, vargs)
      logger?.log('created signable transaction result')
      return r
    }

    prior.tx = await traceActionStep(
      wallet,
      'wallet.create_action.complete_signing',
      parent,
      async () => await completeSignedTransaction(prior!, {}, wallet)
    )
    logger?.log('completed signed transaction')

    r.txid = prior.tx.id('hex')
    const beef = new Beef()
    if (prior.dcr.inputBeef != null) {
      const inputBeef =
        prior.dcr.inputBeef instanceof Uint8Array
          ? Beef.fromBinaryView(prior.dcr.inputBeef)
          : Beef.fromBinary(prior.dcr.inputBeef)
      beef.mergeBeef(inputBeef)
    }
    beef.mergeTransaction(prior.tx)
    logger?.log('merged beef')

    await traceActionStep(
      wallet,
      'wallet.create_action.verify_unlock_scripts',
      parent,
      async () => await verifyUnlockScripts(r.txid!, beef, wallet.scriptVerifier)
    )
    logger?.log('verified unlock scripts')

    r.noSendChange = prior.dcr.noSendChangeOutputVouts?.map(vout => `${r.txid}.${vout}`)
    beef.atomicTxid = r.txid
    setResultBeef(r, beef)
    if (!vargs.options.returnTXIDOnly) r.tx = beef.toUint8ArrayAtomic(r.txid)
  }

  const { sendWithResults, notDelayedResults } = await traceActionStep(
    wallet,
    'wallet.create_action.process',
    parent,
    async () => await processAction(prior, wallet, auth, vargs)
  )
  logger?.log('processed transaction')

  r.sendWithResults = sendWithResults
  r.notDelayedResults = notDelayedResults

  return r
}

async function traceActionStep<T>(
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

async function createNewTx(
  wallet: Wallet,
  vargs: Validation.ValidCreateActionArgs,
  parent?: TelemetrySpan
): Promise<PendingSignAction> {
  const logger = vargs.logger
  const storageArgs = removeUnlockScripts(vargs)
  const dcr = await traceActionStep(
    wallet,
    'wallet.create_action.storage_plan',
    parent,
    async () => (await wallet.actionBatch.plan(storageArgs)) ?? (await wallet.storage.createAction(storageArgs))
  )

  const reference = dcr.reference

  const { tx, amount, pdi } = await traceActionStep(
    wallet,
    'wallet.create_action.build_signable_transaction',
    parent,
    () => buildSignableTransaction(dcr, vargs, wallet)
  )
  logger?.log('built signable transaction')

  const prior: PendingSignAction = { reference, dcr, args: vargs, amount, tx, pdi }

  return prior
}

function makeSignableTransactionResult(
  prior: PendingSignAction,
  wallet: Wallet,
  args: Validation.ValidCreateActionArgs
): CreateActionResult {
  if (prior.dcr.inputBeef == null) throw new WERR_INTERNAL('prior.dcr.inputBeef must be valid')

  const txid = prior.tx.id('hex')

  const r: CreateActionResult = {
    noSendChange: args.isNoSend ? prior.dcr.noSendChangeOutputVouts?.map(vout => `${txid}.${vout}`) : undefined,
    signableTransaction: {
      reference: prior.dcr.reference,
      tx: makeSignableTransactionBeef(prior.tx)
    }
  }

  wallet.pendingSignActions[r.signableTransaction!.reference] = prior

  return r
}

function makeSignableTransactionBeef(tx: Transaction): number[] {
  // This is a special case beef for transaction signing.
  // We only need the transaction being signed, and for each input, the raw source transaction.
  const beef = new Beef()
  for (const input of tx.inputs) {
    if (input.sourceTransaction == null) {
      throw new WERR_INTERNAL('Every signableTransaction input must have a sourceTransaction')
    }
    beef.mergeRawTx(input.sourceTransaction.toUint8Array())
  }
  beef.mergeRawTx(tx.toUint8Array())
  // BRC-100 historically returns number[] here. Keep that observable shape;
  // Wallet Wire converts it to compact bytes only inside negotiated substrates.
  return beef.toBinaryAtomic(tx.id('hex'))
}

function removeUnlockScripts(args: Validation.ValidCreateActionArgs) {
  let storageArgs = args
  if (!storageArgs.inputs.every(i => i.unlockingScript === undefined)) {
    // Never send unlocking scripts to storage, all it needs is the script length.
    storageArgs = { ...args, inputs: [] }
    for (const i of args.inputs) {
      const di: Validation.ValidCreateActionInput = {
        ...i,
        unlockingScriptLength: i.unlockingScript !== undefined ? i.unlockingScript.length : i.unlockingScriptLength
      }
      delete di.unlockingScript
      storageArgs.inputs.push(di)
    }
  }
  return storageArgs
}

export async function processAction(
  prior: PendingSignAction | undefined,
  wallet: Wallet,
  auth: AuthId,
  vargs: Validation.ValidProcessActionArgs
): Promise<StorageProcessActionResults> {
  const batchResult = await wallet.actionBatch.process(prior, vargs)
  if (batchResult != null) return batchResult
  const args: StorageProcessActionArgs = {
    isNewTx: vargs.isNewTx,
    isSendWith: vargs.isSendWith,
    isNoSend: vargs.isNoSend,
    isDelayed: vargs.isDelayed,
    reference: prior != null ? prior.reference : undefined,
    txid: prior != null ? prior.tx.id('hex') : undefined,
    rawTx: prior != null ? prior.tx.toUint8Array() : undefined,
    sendWith: vargs.isSendWith ? vargs.options.sendWith : [],
    logger: vargs.logger
  }
  const r: StorageProcessActionResults = await wallet.storage.processAction(args)

  return r
}
