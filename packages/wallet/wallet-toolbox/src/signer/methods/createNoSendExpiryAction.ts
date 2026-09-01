import { Beef, PublicKey, Random, Script, Transaction, Utils, Validation } from '@bsv/sdk'
import { Wallet, PendingSignAction, PendingStorageInput } from '../../Wallet'
import { AuthId, StorageCreateActionResult } from '../../sdk/WalletStorage.interfaces'
import { WERR_INTERNAL, WERR_INVALID_OPERATION, WERR_REVIEW_ACTIONS } from '../../sdk/WERR_errors'
import { ScriptTemplateBRC29, brc29ProtocolID } from '../../utility/ScriptTemplateBRC29'
import { Brc177ValidCreateActionArgs } from '../../utility/brc177NoSendExpiry'
import { buildSignableTransaction } from './buildSignableTransaction'
import { completeSignedTransaction, verifyUnlockScripts } from './completeSignedTransaction'
import { CreateActionResultX, processAction } from './createAction'
import { setResultBeef } from './resultBeef'
import { makeNoSendExpiryFundingArgs } from '../../storage/methods/noSendExpiry'

function pendingFromPlan(
  wallet: Wallet,
  args: Validation.ValidCreateActionArgs,
  dcr: StorageCreateActionResult
): PendingSignAction {
  const { tx, amount, pdi } = buildSignableTransaction(dcr, args, wallet)
  return { reference: dcr.reference, dcr, args, tx, amount, pdi }
}

function beefForPending(prior: PendingSignAction): Beef {
  if (prior.dcr.inputBeef == null) throw new WERR_INTERNAL('planned action must include input BEEF')
  const beef =
    prior.dcr.inputBeef instanceof Uint8Array
      ? Beef.fromBinaryView(prior.dcr.inputBeef)
      : Beef.fromBinary(prior.dcr.inputBeef)
  beef.mergeTransaction(prior.tx)
  return beef
}

async function completeFunding(
  wallet: Wallet,
  auth: AuthId,
  prior: PendingSignAction,
  args: Validation.ValidCreateActionArgs
): Promise<{ txid: string; beef: Beef }> {
  prior.tx = await completeSignedTransaction(prior, {}, wallet)
  const txid = prior.tx.id('hex')
  const beef = beefForPending(prior)
  await verifyUnlockScripts(txid, beef, wallet.scriptVerifier)
  const processed = await processAction(prior, wallet, auth, args)
  const failed = processed.sendWithResults?.some(result => result.status !== 'unproven') ?? false
  if (failed || processed.notDelayedResults == null) {
    throw new WERR_REVIEW_ACTIONS(
      processed.notDelayedResults ?? [],
      processed.sendWithResults ?? [],
      txid,
      beef.toBinaryAtomic(txid)
    )
  }
  return { txid, beef }
}

function findAnchorInput(prior: PendingSignAction, anchorTxid: string, anchorVout: number): PendingStorageInput {
  const input = prior.pdi.find(candidate => {
    const txInput = prior.tx.inputs[candidate.vin]
    return txInput?.sourceTXID === anchorTxid && txInput.sourceOutputIndex === anchorVout
  })
  if (input == null || prior.pdi.length !== 1) {
    throw new WERR_INVALID_OPERATION('BRC-177 protected action does not have exactly one managed anchor input')
  }
  return input
}

function randomDerivation(): string {
  return Utils.toBase64(Random(16))
}

export function targetForStorage(args: Validation.ValidCreateActionArgs): Validation.ValidCreateActionArgs {
  const target = {
    ...args,
    inputs: args.inputs.map(input => {
      const sanitized = { ...input }
      delete sanitized.unlockingScript
      return sanitized
    }),
    outputs: args.outputs.map(output => ({ ...output, tags: [...output.tags] })),
    labels: [...args.labels],
    options: {
      ...args.options,
      knownTxids: [...args.options.knownTxids],
      noSendChange: args.options.noSendChange.map(outpoint => ({ ...outpoint })),
      sendWith: [...args.options.sendWith]
    },
    randomVals: args.randomVals == null ? undefined : [...args.randomVals]
  }
  // Logger instances and externally supplied unlocking scripts are local
  // signer concerns. In particular, a nested logger cannot be reconstructed by
  // StorageClient's top-level RPC logger handshake.
  delete target.logger
  return target
}

async function makeReclaim(
  wallet: Wallet,
  fundingTx: Transaction,
  target: PendingSignAction,
  anchorTxid: string,
  anchorVout: number,
  reclaimSatoshis: number
): Promise<{
  tx: Transaction
  derivationPrefix: string
  derivationSuffix: string
}> {
  const anchor = findAnchorInput(target, anchorTxid, anchorVout)
  const keys = wallet.getClientChangeKeyPair()
  const derivationPrefix = randomDerivation()
  const derivationSuffix = randomDerivation()
  const outputTemplate = new ScriptTemplateBRC29({
    derivationPrefix,
    derivationSuffix,
    keyDeriver: wallet.keyDeriver
  })
  const reclaim = new Transaction(1, [], [], 0)
  reclaim.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: anchorVout,
    unlockingScript: new Script(),
    sequence: 0xffffffff
  })
  reclaim.addOutput({
    satoshis: reclaimSatoshis,
    lockingScript: outputTemplate.lock(keys.privateKey, keys.publicKey),
    change: true
  })

  const inputTemplate = new ScriptTemplateBRC29({
    derivationPrefix: anchor.derivationPrefix,
    derivationSuffix: anchor.derivationSuffix,
    keyDeriver: wallet.keyDeriver
  })
  const counterparty = PublicKey.fromString(anchor.unlockerPubKey || keys.publicKey)
  const privateKey = wallet.keyDeriver.derivePrivateKey(brc29ProtocolID, inputTemplate.getKeyID(), counterparty)
  reclaim.inputs[0].unlockingScriptTemplate = inputTemplate.unlockWithDerivedPrivateKey(
    privateKey,
    anchor.sourceSatoshis,
    Script.fromHex(anchor.lockingScript)
  )
  await reclaim.sign()
  return { tx: reclaim, derivationPrefix, derivationSuffix }
}

function makeSignableBeef(tx: Transaction): number[] {
  const beef = new Beef()
  for (const input of tx.inputs) {
    if (input.sourceTransaction == null) {
      throw new WERR_INTERNAL('Every BRC-177 signable input must have a source transaction')
    }
    beef.mergeRawTx(input.sourceTransaction.toUint8Array())
  }
  beef.mergeRawTx(tx.toUint8Array())
  return beef.toBinaryAtomic(tx.id('hex'))
}

async function armReclaim(
  wallet: Wallet,
  target: PendingSignAction,
  fundingBeef: Beef,
  reclaim: Awaited<ReturnType<typeof makeReclaim>>,
  reclaimSatoshis: number
): Promise<void> {
  const reclaimTxid = reclaim.tx.id('hex')
  const keys = wallet.getClientChangeKeyPair()
  const expectedLock = new ScriptTemplateBRC29({
    derivationPrefix: reclaim.derivationPrefix,
    derivationSuffix: reclaim.derivationSuffix,
    keyDeriver: wallet.keyDeriver
  }).lock(keys.privateKey, keys.publicKey)
  if (
    reclaim.tx.inputs.length !== 1 ||
    reclaim.tx.outputs.length !== 1 ||
    reclaim.tx.outputs[0].satoshis !== reclaimSatoshis ||
    reclaim.tx.outputs[0].lockingScript.toHex() !== expectedLock.toHex()
  ) {
    throw new WERR_INTERNAL('BRC-177 reclaim does not return the anchor to wallet-controlled value')
  }
  const verificationBeef = fundingBeef.clone()
  verificationBeef.mergeTransaction(reclaim.tx)
  await verifyUnlockScripts(reclaimTxid, verificationBeef, wallet.scriptVerifier)
  await wallet.storage.armNoSendExpiry({
    reference: target.reference,
    reclaimTxid,
    reclaimRawTx: reclaim.tx.toUint8Array(),
    reclaimDerivationPrefix: reclaim.derivationPrefix,
    reclaimDerivationSuffix: reclaim.derivationSuffix,
    reclaimSatoshis
  })
}

export async function createNoSendExpiryAction(
  wallet: Wallet,
  auth: AuthId,
  vargs: Validation.ValidCreateActionArgs
): Promise<CreateActionResultX> {
  const capabilities = await wallet.storage.getCapabilities()
  if (capabilities.brc177NoSendExpiry?.version !== 1) {
    throw new WERR_INVALID_OPERATION('Active storage does not support BRC-177 noSend expiry')
  }

  // The flow crosses an on-chain network round trip. Snapshot every mutable
  // request collection before it so caller mutation cannot change what the
  // signer later builds relative to the plan already committed by storage.
  const targetSnapshot = {
    ...vargs,
    inputBEEF: vargs.inputBEEF == null ? undefined : Array.from(vargs.inputBEEF),
    inputs: vargs.inputs.map(input => ({ ...input })),
    outputs: vargs.outputs.map(output => ({ ...output, tags: [...output.tags] })),
    labels: [...vargs.labels],
    options: {
      ...vargs.options,
      knownTxids: [...vargs.options.knownTxids],
      noSendChange: vargs.options.noSendChange.map(outpoint => ({ ...outpoint })),
      sendWith: [...vargs.options.sendWith]
    },
    randomVals: vargs.randomVals == null ? undefined : [...vargs.randomVals]
  }
  const storageTarget = targetForStorage(targetSnapshot)
  const prepared = await wallet.storage.prepareNoSendExpiry(storageTarget)
  const fundingArgs = makeNoSendExpiryFundingArgs(prepared.anchorSatoshis, targetSnapshot.labels)
  fundingArgs.includeAllSourceTransactions = targetSnapshot.includeAllSourceTransactions
  let funding: PendingSignAction
  let completedFunding: Awaited<ReturnType<typeof completeFunding>>
  try {
    funding = pendingFromPlan(wallet, fundingArgs, prepared.funding)
    completedFunding = await completeFunding(wallet, auth, funding, fundingArgs)
  } catch (error) {
    await wallet.storage.abortAction({ reference: prepared.funding.reference }).catch(() => undefined)
    throw error
  }

  const activated = await wallet.storage.activateNoSendExpiry({
    target: storageTarget,
    fundingReference: funding.reference,
    fundingTxid: completedFunding.txid,
    anchorVout: prepared.anchorVout
  })
  const targetArgs: Brc177ValidCreateActionArgs = {
    ...targetSnapshot,
    options: {
      ...targetSnapshot.options,
      noSendChange: [{ txid: activated.anchorTxid, vout: activated.anchorVout }],
      sendWith: [...targetSnapshot.options.sendWith]
    },
    brc177: {
      kind: 'protected',
      expiry: activated.expiry,
      deadline: activated.deadline,
      anchorTxid: activated.anchorTxid,
      anchorVout: activated.anchorVout
    }
  }
  let target: PendingSignAction

  try {
    target = pendingFromPlan(wallet, targetArgs, activated.action)
    const reclaim = await makeReclaim(
      wallet,
      funding.tx,
      target,
      activated.anchorTxid,
      activated.anchorVout,
      prepared.reclaimSatoshis
    )
    await armReclaim(wallet, target, completedFunding.beef, reclaim, prepared.reclaimSatoshis)
  } catch (error) {
    await wallet.storage.abortAction({ reference: activated.action.reference }).catch(() => undefined)
    throw error
  }

  if (targetArgs.isSignAction) {
    try {
      const tx = makeSignableBeef(target.tx)
      wallet.pendingSignActions[target.reference] = target
      return {
        signableTransaction: {
          reference: target.reference,
          tx
        }
      }
    } catch (error) {
      await wallet.storage.abortAction({ reference: target.reference }).catch(() => undefined)
      throw error
    }
  }

  try {
    target.tx = await completeSignedTransaction(target, {}, wallet)
    const txid = target.tx.id('hex')
    const beef = beefForPending(target)
    await verifyUnlockScripts(txid, beef, wallet.scriptVerifier)
    const processed = await processAction(target, wallet, auth, targetArgs)
    beef.atomicTxid = txid
    const result: CreateActionResultX = {
      txid,
      tx: beef.toBinaryAtomic(txid),
      sendWithResults: processed.sendWithResults,
      notDelayedResults: processed.notDelayedResults
    }
    setResultBeef(result, beef)
    return result
  } catch (error) {
    await wallet.storage.abortAction({ reference: target.reference }).catch(() => undefined)
    throw error
  }
}
