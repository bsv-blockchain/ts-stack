import {
  AtomicBEEF,
  Beef,
  CreateActionResult,
  OutpointString,
  SendWithResult,
  SignableTransaction,
  TXIDHexString,
  Script,
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
  const r: CreateActionResultX = {}
  const logger = vargs.logger

  let prior: PendingSignAction | undefined = undefined

  if (vargs.isNewTx || vargs.isTestWerrReviewActions) {
    prior = await createNewTx(wallet, vargs)
    logger?.log('created new transaction')

    if (vargs.isSignAction) {
      const r = makeSignableTransactionResult(prior, wallet, vargs)
      logger?.log('created signable transaction result')
      return r
    }

    prior.tx = await completeSignedTransaction(prior, {}, wallet)
    logger?.log('completed signed transaction')

    r.txid = prior.tx.id('hex')
    const beef = new Beef()
    if (prior.dcr.inputBeef) beef.mergeBeef(prior.dcr.inputBeef)
    beef.mergeTransaction(prior.tx)
    logger?.log('merged beef')

    verifyUnlockScripts(r.txid, beef)
    logger?.log('verified unlock scripts')

    r.noSendChange = prior.dcr.noSendChangeOutputVouts?.map(vout => `${r.txid}.${vout}`)
    if (!vargs.options.returnTXIDOnly) r.tx = beef.toBinaryAtomic(r.txid)
  }

  const { sendWithResults, notDelayedResults } = await processAction(prior, wallet, auth, vargs)
  logger?.log('processed transaction')

  r.sendWithResults = sendWithResults
  r.notDelayedResults = notDelayedResults

  return r
}

async function createNewTx(wallet: Wallet, vargs: Validation.ValidCreateActionArgs): Promise<PendingSignAction> {
  const logger = vargs.logger
  const storageArgs = removeUnlockScripts(vargs)
  const dcr = await wallet.storage.createAction(storageArgs)

  const reference = dcr.reference

  const { tx, amount, pdi } = buildSignableTransaction(dcr, vargs, wallet)
  logger?.log('built signable transaction')

  const prior: PendingSignAction = { reference, dcr, args: vargs, amount, tx, pdi }

  return prior
}

function makeSignableTransactionResult(
  prior: PendingSignAction,
  wallet: Wallet,
  args: Validation.ValidCreateActionArgs
): CreateActionResult {
  if (!prior.dcr.inputBeef) throw new WERR_INTERNAL('prior.dcr.inputBeef must be valid')

  const txid = prior.tx.id('hex')

  const r: CreateActionResult = {
    noSendChange: args.isNoSend ? prior.dcr.noSendChangeOutputVouts?.map(vout => `${txid}.${vout}`) : undefined,
    signableTransaction: {
      reference: prior.dcr.reference,
      tx: makeSignableTransactionBeef(prior.tx, prior.dcr.inputBeef)
    }
  }

  wallet.pendingSignActions[r.signableTransaction!.reference] = prior

  return r
}

function makeSignableTransactionBeef(tx: Transaction, inputBEEF: number[]): number[] {
  // This is a special case beef for transaction signing.
  // We only need the transaction being signed, and for each input, the raw source transaction.
  const beef = new Beef()
  for (const input of tx.inputs) {
    if (!input.sourceTransaction)
      throw new WERR_INTERNAL('Every signableTransaction input must have a sourceTransaction')
    beef.mergeRawTx(input.sourceTransaction!.toBinary())
  }
  beef.mergeRawTx(tx.toBinary())
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
  const args: StorageProcessActionArgs = {
    isNewTx: vargs.isNewTx,
    isSendWith: vargs.isSendWith,
    isNoSend: vargs.isNoSend,
    isDelayed: vargs.isDelayed,
    reference: prior ? prior.reference : undefined,
    txid: prior ? prior.tx.id('hex') : undefined,
    rawTx: prior ? prior.tx.toBinary() : undefined,
    sendWith: vargs.isSendWith ? vargs.options.sendWith : [],
    logger: vargs.logger
  }
  const r: StorageProcessActionResults = await wallet.storage.processAction(args)

  return r
}

function makeDummyTransactionForOutputSatoshis(vout: number, satoshis: number): Transaction {
  const tx = new Transaction()
  for (let i = 0; i < vout; i++) tx.addOutput({ lockingScript: new Script(), satoshis: 0 })
  tx.addOutput({ lockingScript: new Script(), satoshis })
  return tx
}
