import { Beef, Transaction, TransactionSignature, Utils, Validation } from '@bsv/sdk'
import {
  AuthId,
  StorageActivateNoSendExpiryArgs,
  StorageActivateNoSendExpiryResult,
  StorageArmNoSendExpiryArgs,
  StoragePrepareNoSendExpiryResult,
  TrxToken
} from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { Brc177ValidCreateActionArgs, parseBrc177NoSendExpiryLabels } from '../../utility/brc177NoSendExpiry'
import { verifyId, verifyOne } from '../../utility/utilityHelpers'
import { asArray } from '../../utility/utilityHelpers.noBuffer'
import { StorageProvider, validateStorageFeeModel } from '../StorageProvider'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { createAction, validateRequiredInputs, validateRequiredOutputs } from './createAction'
import { transactionSize } from './utils'
import { verifyUnlockScripts } from '../../signer/methods/completeSignedTransaction'

const MANAGED_INPUT_UNLOCKING_SCRIPT_LENGTH = 107
const MANAGED_OUTPUT_LOCKING_SCRIPT_LENGTH = 25
const CONSERVATIVE_RECLAIM_SATS_PER_KB = 1000
const MAX_RECLAIM_RAW_TX_BYTES = 1000

export function validateNoSendExpiryRequest(
  args: Validation.ValidCreateActionArgs
): ReturnType<typeof parseBrc177NoSendExpiryLabels> {
  const expiry = parseBrc177NoSendExpiryLabels(args.labels)
  if (expiry == null) return undefined
  if (!args.isNewTx || args.outputs.length === 0) {
    throw new WERR_INVALID_PARAMETER('outputs', 'at least one output for a BRC-177 protected action')
  }
  if (!args.options.noSend) {
    throw new WERR_INVALID_PARAMETER('options.noSend', 'true for a BRC-177 protected action')
  }
  if (args.options.sendWith.length > 0) {
    throw new WERR_INVALID_PARAMETER('options.sendWith', 'empty for a BRC-177 protected action')
  }
  if (args.options.noSendChange.length > 0) {
    throw new WERR_INVALID_PARAMETER('options.noSendChange', 'empty for a BRC-177 protected action')
  }
  if (args.options.returnTXIDOnly) {
    throw new WERR_INVALID_PARAMETER('options.returnTXIDOnly', 'false for a BRC-177 protected action')
  }
  return expiry
}

export function makeNoSendExpiryFundingArgs(
  anchorSatoshis: number,
  protectedLabels: string[] = []
): Brc177ValidCreateActionArgs {
  const attributionLabels = protectedLabels.filter(
    label => label.startsWith('admin originator ') || label.startsWith('admin month ')
  )
  const args = Validation.validateCreateActionArgs({
    description: 'BRC-177 expiry anchor funding',
    labels: [...new Set(['admin brc177 funding', ...attributionLabels])],
    options: {
      acceptDelayedBroadcast: false,
      noSend: false,
      randomizeOutputs: false,
      returnTXIDOnly: false,
      signAndProcess: true
    }
  }) as Brc177ValidCreateActionArgs
  args.brc177 = { kind: 'funding', anchorSatoshis }
  return args
}

function feeForSize(storage: StorageProvider, size: number, minimumSatsPerKb = 0): number {
  const feeModel = validateStorageFeeModel(storage.feeModel)
  const satsPerKb = Math.max(feeModel.value || 0, minimumSatsPerKb)
  return Math.ceil((size / 1000) * satsPerKb)
}

function reclaimValues(
  storage: StorageProvider,
  anchorSatoshis: number
): { reclaimFee: number; reclaimSatoshis: number } {
  const reclaimSize = transactionSize([MANAGED_INPUT_UNLOCKING_SCRIPT_LENGTH], [MANAGED_OUTPUT_LOCKING_SCRIPT_LENGTH])
  const reclaimFee = feeForSize(storage, reclaimSize, CONSERVATIVE_RECLAIM_SATS_PER_KB)
  const currentFee = feeForSize(storage, reclaimSize)
  const minimumOutput = Math.max(1, currentFee * 2)
  const reclaimSatoshis = anchorSatoshis - reclaimFee
  if (reclaimSatoshis < minimumOutput) {
    throw new WERR_INVALID_PARAMETER(
      'outputs',
      `a no-change BRC-177 action whose anchor leaves at least ${minimumOutput} satoshis after its ${reclaimFee}-satoshi reclaim fee`
    )
  }
  return { reclaimFee, reclaimSatoshis }
}

async function estimateAnchorSatoshis(
  storage: StorageProvider,
  userId: number,
  target: Validation.ValidCreateActionArgs
): Promise<number> {
  const { xinputs } = await validateRequiredInputs(storage, userId, target)
  const xoutputs = validateRequiredOutputs(storage, userId, target)
  const size = transactionSize(
    [...xinputs.map(input => input.unlockingScriptLength), MANAGED_INPUT_UNLOCKING_SCRIPT_LENGTH],
    xoutputs.map(output => output.lockingScript.length / 2)
  )
  const inputSatoshis = xinputs.reduce((sum, input) => sum + input.satoshis, 0)
  const outputSatoshis = xoutputs.reduce((sum, output) => sum + output.satoshis, 0)
  const anchorSatoshis = outputSatoshis + feeForSize(storage, size) - inputSatoshis
  if (!Number.isSafeInteger(anchorSatoshis) || anchorSatoshis <= 0) {
    throw new WERR_INVALID_PARAMETER('inputs', 'a BRC-177 action requiring a positive, exactly sized revocation anchor')
  }
  return anchorSatoshis
}

export async function prepareNoSendExpiry(
  storage: StorageProvider,
  auth: AuthId,
  target: Validation.ValidCreateActionArgs
): Promise<StoragePrepareNoSendExpiryResult> {
  const expiry = validateNoSendExpiryRequest(target)
  if (expiry == null) {
    throw new WERR_INVALID_PARAMETER('labels', 'a BRC-177 noSend expiry label')
  }
  if (expiry.mode === 'timestamp' && expiry.value <= Math.floor(Date.now() / 1000)) {
    throw new WERR_INVALID_PARAMETER('labels', 'a BRC-177 timestamp later than the current time')
  }
  if (expiry.mode === 'seconds' && !Number.isSafeInteger(Math.floor(Date.now() / 1000) + expiry.value)) {
    throw new WERR_INVALID_PARAMETER('labels', 'a safely schedulable BRC-177 seconds duration')
  }
  if (expiry.mode === 'blockheight' && expiry.value <= (await storage.getServices().getHeight())) {
    throw new WERR_INVALID_PARAMETER('labels', 'a BRC-177 blockheight later than the current best-chain height')
  }
  const userId = verifyId(auth.userId)
  const anchorSatoshis = await estimateAnchorSatoshis(storage, userId, target)
  const { reclaimFee, reclaimSatoshis } = reclaimValues(storage, anchorSatoshis)
  const fundingArgs = makeNoSendExpiryFundingArgs(anchorSatoshis, target.labels)
  fundingArgs.includeAllSourceTransactions = target.includeAllSourceTransactions
  const funding = await createAction(storage, auth, fundingArgs)
  const anchor = funding.outputs.find(output => output.providedBy === 'storage' && output.purpose === 'change')
  if (anchor == null || anchor.satoshis !== anchorSatoshis) {
    throw new WERR_INVALID_OPERATION('BRC-177 funding plan did not contain its exact revocation anchor')
  }
  return {
    funding,
    anchorSatoshis,
    anchorVout: anchor.vout,
    reclaimFee,
    reclaimSatoshis
  }
}

async function resolveDeadline(
  storage: StorageProvider,
  expiry: NonNullable<ReturnType<typeof parseBrc177NoSendExpiryLabels>>
): Promise<number> {
  if (expiry.mode === 'blockheight') {
    const height = await storage.getServices().getHeight()
    if (expiry.value <= height) {
      throw new WERR_INVALID_PARAMETER('labels', 'a BRC-177 blockheight later than the current best-chain height')
    }
    return expiry.value
  }
  const now = Math.floor(Date.now() / 1000)
  if (expiry.mode === 'timestamp') {
    if (expiry.value <= now) {
      throw new WERR_INVALID_PARAMETER('labels', 'a BRC-177 timestamp later than the current time')
    }
    return expiry.value
  }
  const deadline = now + expiry.value
  if (!Number.isSafeInteger(deadline)) {
    throw new WERR_INVALID_PARAMETER('labels', 'a safely schedulable BRC-177 seconds duration')
  }
  return deadline
}

export async function activateNoSendExpiry(
  storage: StorageProvider,
  auth: AuthId,
  args: StorageActivateNoSendExpiryArgs
): Promise<StorageActivateNoSendExpiryResult> {
  const expiry = validateNoSendExpiryRequest(args.target)
  if (expiry == null) throw new WERR_INVALID_PARAMETER('labels', 'a BRC-177 noSend expiry label')
  const userId = verifyId(auth.userId)
  const funding = verifyOne(
    await storage.findTransactions({
      partial: { userId, reference: args.fundingReference, txid: args.fundingTxid }
    })
  )
  if (funding.status !== 'unproven' && funding.status !== 'completed') {
    throw new WERR_INVALID_OPERATION('BRC-177 funding transaction was not accepted by a processor')
  }
  const anchor = verifyOne(
    await storage.findOutputs({
      partial: { userId, txid: args.fundingTxid, vout: args.anchorVout }
    })
  )
  if (!anchor.change || anchor.type !== 'P2PKH' || anchor.purpose !== 'change' || !anchor.spendable) {
    throw new WERR_INVALID_OPERATION('BRC-177 revocation anchor is not available managed change')
  }

  const expectedAnchor = await estimateAnchorSatoshis(storage, userId, args.target)
  if (Number(anchor.satoshis) !== expectedAnchor) {
    throw new WERR_INVALID_OPERATION('BRC-177 revocation anchor no longer exactly funds the protected action')
  }
  reclaimValues(storage, expectedAnchor)
  const deadline = await resolveDeadline(storage, expiry)
  const target = {
    ...args.target,
    inputs: [...args.target.inputs],
    outputs: [...args.target.outputs],
    labels: [...args.target.labels],
    options: {
      ...args.target.options,
      noSend: true,
      noSendChange: [{ txid: args.fundingTxid, vout: args.anchorVout }],
      sendWith: [],
      returnTXIDOnly: false
    }
  } as Brc177ValidCreateActionArgs
  target.brc177 = {
    kind: 'protected',
    expiry,
    deadline,
    anchorTxid: args.fundingTxid,
    anchorVout: args.anchorVout
  }
  const action = await createAction(storage, auth, target)
  return {
    action,
    expiry,
    deadline,
    anchorTxid: args.fundingTxid,
    anchorVout: args.anchorVout
  }
}

function validateDerivation(value: string, name: string): void {
  let bytes: number[]
  try {
    bytes = Utils.toArray(value, 'base64')
  } catch {
    throw new WERR_INVALID_PARAMETER(name, 'a 16-byte base64 derivation')
  }
  if (bytes.length !== 16 || Utils.toBase64(bytes) !== value) {
    throw new WERR_INVALID_PARAMETER(name, 'a canonical 16-byte base64 derivation')
  }
}

function hasCanonicalAllP2pkhUnlock(reclaim: Transaction): boolean {
  const chunks = reclaim.inputs[0]?.unlockingScript?.chunks
  const checksig = chunks?.[0]?.data
  const publicKey = chunks?.[1]?.data
  if (chunks?.length !== 2 || checksig == null || publicKey?.length !== 33) return false
  try {
    const signature = TransactionSignature.fromChecksigFormat(checksig)
    return (
      signature.scope === (TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID) &&
      signature.hasLowS() &&
      Utils.toHex(signature.toChecksigFormat()) === Utils.toHex(checksig)
    )
  } catch {
    return false
  }
}

function parseCanonicalReclaim(args: StorageArmNoSendExpiryArgs): { reclaim: Transaction; rawTx: number[] } {
  const rawTx = asArray(args.reclaimRawTx)
  if (rawTx.length > MAX_RECLAIM_RAW_TX_BYTES) {
    throw new WERR_INVALID_PARAMETER('reclaimRawTx', `at most ${MAX_RECLAIM_RAW_TX_BYTES} bytes`)
  }
  let reclaim: Transaction
  try {
    reclaim = Transaction.fromBinary(rawTx)
  } catch {
    throw new WERR_INVALID_PARAMETER('reclaimRawTx', 'a valid serialized reclaim transaction')
  }
  if (Utils.toHex(reclaim.toUint8Array()) !== Utils.toHex(rawTx)) {
    throw new WERR_INVALID_PARAMETER('reclaimRawTx', 'a canonical serialized reclaim transaction')
  }
  if (reclaim.id('hex') !== args.reclaimTxid) {
    throw new WERR_INVALID_PARAMETER('reclaimTxid', 'the hash of reclaimRawTx')
  }
  return { reclaim, rawTx }
}

function validateReclaimOutput(
  storage: StorageProvider,
  anchorSatoshis: number,
  args: StorageArmNoSendExpiryArgs,
  reclaim: Transaction
): void {
  const expected = reclaimValues(storage, anchorSatoshis).reclaimSatoshis
  if (args.reclaimSatoshis !== expected || reclaim.outputs.length !== 1 || reclaim.outputs[0].satoshis !== expected) {
    throw new WERR_INVALID_PARAMETER('reclaimSatoshis', 'the exact BRC-177 reclaim amount')
  }
  if (!/^76a914[0-9a-f]{40}88ac$/.test(reclaim.outputs[0].lockingScript.toHex())) {
    throw new WERR_INVALID_PARAMETER('reclaimRawTx', 'one canonical P2PKH managed-change output')
  }
}

function validateReclaimSpend(target: TableTransaction, reclaim: Transaction): void {
  const input = reclaim.inputs[0]
  if (
    reclaim.inputs.length !== 1 ||
    input.sourceTXID !== target.noSendExpiryAnchorTxid ||
    input.sourceOutputIndex !== target.noSendExpiryAnchorVout ||
    input.sequence !== 0xffffffff ||
    reclaim.lockTime !== 0 ||
    input.unlockingScript == null ||
    input.unlockingScript.toHex().length === 0 ||
    !hasCanonicalAllP2pkhUnlock(reclaim)
  ) {
    throw new WERR_INVALID_PARAMETER(
      'reclaimRawTx',
      'an immediately valid SIGHASH_ALL transaction spending only the revocation anchor'
    )
  }
}

async function verifyReclaimSignature(
  storage: StorageProvider,
  target: TableTransaction,
  rawTx: number[],
  reclaimTxid: string,
  trx?: TrxToken
): Promise<void> {
  let sourceRawTx: number[]
  try {
    const source = await storage.getRawTxOfKnownValidTransaction(
      target.noSendExpiryAnchorTxid!,
      undefined,
      undefined,
      trx
    )
    if (source == null) throw new Error('missing source transaction')
    sourceRawTx = asArray(source)
  } catch {
    throw new WERR_INVALID_OPERATION('BRC-177 revocation anchor source transaction is unavailable')
  }
  const verificationBeef = new Beef()
  verificationBeef.mergeRawTx(sourceRawTx)
  verificationBeef.mergeRawTx(rawTx)
  try {
    await verifyUnlockScripts(reclaimTxid, verificationBeef, storage.scriptVerifier)
  } catch {
    throw new WERR_INVALID_PARAMETER('reclaimRawTx', 'a valid signature for the revocation anchor')
  }
}

async function validateArmSnapshot(
  storage: StorageProvider,
  userId: number,
  reference: string,
  args: StorageArmNoSendExpiryArgs,
  reclaim: Transaction,
  trx?: TrxToken
): Promise<TableTransaction> {
  const target = verifyOne(
    await storage.findTransactions({
      partial: { userId, reference },
      trx
    })
  )
  if (target.status !== 'unsigned' || target.noSendExpiryState !== 'preparing') {
    throw new WERR_INVALID_OPERATION('BRC-177 action is not waiting to be armed')
  }
  if (
    target.noSendExpiryMode == null ||
    target.noSendExpiryDeadline == null ||
    target.noSendExpiryAnchorTxid == null ||
    target.noSendExpiryAnchorVout == null
  ) {
    throw new WERR_INVALID_OPERATION('BRC-177 action metadata is incomplete')
  }
  const now = Math.floor(Date.now() / 1000)
  if (target.noSendExpiryMode !== 'blockheight' && target.noSendExpiryDeadline <= now) {
    throw new WERR_INVALID_OPERATION('BRC-177 action expired before it could be armed')
  }
  const anchor = verifyOne(
    await storage.findOutputs({
      partial: {
        userId,
        txid: target.noSendExpiryAnchorTxid,
        vout: target.noSendExpiryAnchorVout
      },
      trx
    })
  )
  validateReclaimOutput(storage, Number(anchor.satoshis), args, reclaim)
  validateReclaimSpend(target, reclaim)
  return target
}

export async function armNoSendExpiry(
  storage: StorageProvider,
  auth: AuthId,
  args: StorageArmNoSendExpiryArgs
): Promise<void> {
  const userId = verifyId(auth.userId)
  validateDerivation(args.reclaimDerivationPrefix, 'reclaimDerivationPrefix')
  validateDerivation(args.reclaimDerivationSuffix, 'reclaimDerivationSuffix')
  const { reclaim, rawTx } = parseCanonicalReclaim(args)

  // Signature verification can invoke an asynchronous verifier. Keep it out
  // of the IndexedDB write transaction, which browsers may auto-commit while
  // no database request is pending, then revalidate the complete snapshot in
  // the atomic section before publishing the armed state.
  const snapshot = await validateArmSnapshot(storage, userId, args.reference, args, reclaim)
  await verifyReclaimSignature(storage, snapshot, rawTx, args.reclaimTxid, undefined)

  await storage.transaction(async trx => {
    const target = await validateArmSnapshot(storage, userId, args.reference, args, reclaim, trx)
    if (!(await storage.compareAndSetNoSendExpiryState(target.transactionId, 'preparing', 'unsigned', trx))) {
      throw new WERR_INVALID_OPERATION('BRC-177 action changed before it could be armed')
    }
    await storage.updateTransaction(
      target.transactionId,
      {
        noSendExpiryReclaimTxid: args.reclaimTxid,
        noSendExpiryReclaimRawTx: rawTx,
        noSendExpiryReclaimDerivationPrefix: args.reclaimDerivationPrefix,
        noSendExpiryReclaimDerivationSuffix: args.reclaimDerivationSuffix,
        noSendExpiryReclaimSatoshis: args.reclaimSatoshis
      },
      trx
    )
  })
}
