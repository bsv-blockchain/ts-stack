import { Beef, Script, Transaction, Validation } from '@bsv/sdk'
import type { ActionBatchCommitAction, ActionBatchManifest } from '../../sdk/ActionBatch.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { verifyUnlockScripts } from '../../signer/methods/completeSignedTransaction'
import { actionBatchBlobDigest } from '../../utility/actionBatchDigest'
import { beefForTxids } from '../../utility/beefForTxids'
import { asArray, asString } from '../../utility/utilityHelpers.noBuffer'
import type { StorageProvider } from '../StorageProvider'
import { validateStorageFeeModel } from '../StorageProvider'
import type { TableActionBatch } from '../schema/tables/TableActionBatch'
import { maxPossibleSatoshis } from './generateChange'
import { lockScriptWithKeyOffsetFromPubKey } from './offsetKey'
import {
  ACTION_BATCH_MAX_CHUNKS_PER_BLOB,
  ACTION_BATCH_MAX_LOGICAL_BLOB_BYTES
} from './actionBatchBlobs'

export interface ValidatedBatchAction {
  action: ActionBatchCommitAction
  tx: Transaction
  rawTx: number[]
  inputBeef: number[]
}

async function resolveManifestBytes (
  storage: StorageProvider,
  batch: TableActionBatch,
  inline: number[] | Uint8Array | undefined,
  digest: string | undefined,
  name: string,
  chunkDigests?: string[]
): Promise<number[]> {
  if (inline != null) {
    const bytes = asArray(inline)
    if (digest != null && actionBatchBlobDigest(bytes) !== digest) {
      throw new WERR_INVALID_PARAMETER(name, 'match digest')
    }
    return bytes
  }
  if (digest == null) throw new WERR_INVALID_PARAMETER(name, 'inline bytes or digest')
  if (chunkDigests != null) {
    if (chunkDigests.length === 0) throw new WERR_INVALID_PARAMETER(name, 'one or more blob chunks')
    if (chunkDigests.length > ACTION_BATCH_MAX_CHUNKS_PER_BLOB) {
      throw new WERR_INVALID_PARAMETER(name, `at most ${ACTION_BATCH_MAX_CHUNKS_PER_BLOB} blob chunks`)
    }
    const chunks: number[][] = []
    let totalBytes = 0
    for (const chunkDigest of chunkDigests) {
      const chunk = await storage.findActionBatchBlobRecord(batch.actionBatchId, chunkDigest)
      if (chunk == null) throw new WERR_INVALID_OPERATION(`missing action batch blob ${chunkDigest}`)
      if (actionBatchBlobDigest(chunk.bytes) !== chunkDigest) {
        throw new WERR_INVALID_OPERATION(`corrupt action batch blob ${chunkDigest}`)
      }
      totalBytes += chunk.bytes.length
      if (totalBytes > ACTION_BATCH_MAX_LOGICAL_BLOB_BYTES) {
        throw new WERR_INVALID_PARAMETER(name, 'assembled bytes within provider limit')
      }
      chunks.push(chunk.bytes)
    }
    const bytes = new Array<number>(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      for (let index = 0; index < chunk.length; index++) bytes[offset++] = chunk[index]
    }
    if (actionBatchBlobDigest(bytes) !== digest) {
      throw new WERR_INVALID_PARAMETER(name, 'chunks matching digest')
    }
    return bytes
  }
  const blob = await storage.findActionBatchBlobRecord(batch.actionBatchId, digest)
  if (blob == null) throw new WERR_INVALID_OPERATION(`missing action batch blob ${digest}`)
  if (actionBatchBlobDigest(blob.bytes) !== digest) {
    throw new WERR_INVALID_OPERATION(`corrupt action batch blob ${digest}`)
  }
  return blob.bytes
}

function sameStrings (left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? []
  const b = right ?? []
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameNumbers (left: number[] | undefined, right: number[] | undefined): boolean {
  const a = left ?? []
  const b = right ?? []
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function validateActionInputs (action: ActionBatchCommitAction): void {
  if (action.metadata.inputs.length > action.plan.inputs.length) {
    throw new WERR_INVALID_PARAMETER('metadata.inputs', 'align with planned inputs')
  }
  for (let index = 0; index < action.metadata.inputs.length; index++) {
    const requested = action.metadata.inputs[index]
    const planned = action.plan.inputs[index]
    if (planned == null || planned.providedBy === 'storage' ||
      requested.outpoint.txid !== planned.sourceTxid ||
      requested.outpoint.vout !== planned.sourceVout ||
      requested.unlockingScriptLength !== planned.unlockingScriptLength ||
      requested.inputDescription !== planned.spendingDescription) {
      throw new WERR_INVALID_PARAMETER('metadata.inputs', 'match planned explicit inputs')
    }
  }
  if (action.plan.inputs.slice(action.metadata.inputs.length).some(input => input.providedBy !== 'storage')) {
    throw new WERR_INVALID_PARAMETER('metadata.inputs', 'represent every caller-provided input')
  }
}

function validateActionOutputs (action: ActionBatchCommitAction): void {
  if (action.metadata.outputs.length > action.plan.outputs.length) {
    throw new WERR_INVALID_PARAMETER('metadata.outputs', 'align with planned outputs')
  }
  for (let index = 0; index < action.metadata.outputs.length; index++) {
    const requested = action.metadata.outputs[index]
    const planned = action.plan.outputs[index]
    const satoshisMatch = requested.satoshis === maxPossibleSatoshis || requested.satoshis === planned?.satoshis
    if (planned == null || planned.providedBy !== 'you' || !satoshisMatch ||
      requested.lockingScript !== planned.lockingScript ||
      requested.outputDescription !== planned.outputDescription ||
      requested.basket !== planned.basket ||
      requested.customInstructions !== planned.customInstructions ||
      !sameStrings(requested.tags, planned.tags)) {
      throw new WERR_INVALID_PARAMETER('metadata.outputs', 'match planned requested outputs')
    }
  }
  for (const planned of action.plan.outputs.slice(action.metadata.outputs.length)) {
    const isChange = planned.providedBy === 'storage' && planned.purpose === 'change'
    const isCommission = planned.providedBy === 'storage' &&
      (planned.purpose === 'storage-commission' || planned.purpose === 'service-charge')
    if (!isChange && !isCommission) {
      throw new WERR_INVALID_PARAMETER('plan.outputs', 'only requested, change, or commission outputs')
    }
    if (isChange && (planned.basket !== 'default' || planned.tags.length !== 0 ||
      planned.outputDescription !== '' || planned.customInstructions != null ||
      planned.lockingScript !== '' || planned.derivationSuffix == null || action.plan.derivationPrefix.length === 0)) {
      throw new WERR_INVALID_PARAMETER('plan.outputs', 'canonical wallet-managed change metadata')
    }
    if (isCommission && (planned.basket != null || planned.tags.length !== 0 || planned.customInstructions != null)) {
      throw new WERR_INVALID_PARAMETER('plan.outputs', 'canonical storage commission metadata')
    }
  }
}

function validateActionMetadata (action: ActionBatchCommitAction): void {
  Validation.validateCreateActionArgs({
    inputs: action.metadata.inputs.map(input => ({
      ...input,
      outpoint: `${input.outpoint.txid}.${input.outpoint.vout}`
    })),
    outputs: action.metadata.outputs,
    labels: action.metadata.labels,
    description: action.metadata.description,
    version: action.plan.version,
    lockTime: action.plan.lockTime,
    options: {
      noSend: action.metadata.isNoSend,
      acceptDelayedBroadcast: action.metadata.isDelayed,
      randomizeOutputs: false
    }
  })
  validateActionInputs(action)
  validateActionOutputs(action)
}

function validateActionCommission (storage: StorageProvider, action: ActionBatchCommitAction): void {
  const commissions = action.plan.outputs.filter(output =>
    output.purpose === 'storage-commission' || output.purpose === 'service-charge'
  )
  if (storage.commissionSatoshis === 0) {
    if (commissions.length > 0 || action.commissionKeyOffset != null) {
      throw new WERR_INVALID_PARAMETER('commission', 'absent when storage commissions are disabled')
    }
    return
  }
  if (storage.commissionPubKeyHex == null || action.commissionKeyOffset == null || commissions.length !== 1) {
    throw new WERR_INVALID_PARAMETER('commission', 'one output matching the active storage commission')
  }
  const commission = commissions[0]
  const expected = lockScriptWithKeyOffsetFromPubKey(
    storage.commissionPubKeyHex,
    action.commissionKeyOffset
  )
  if (commission.providedBy !== 'storage' || commission.satoshis !== storage.commissionSatoshis ||
    commission.lockingScript !== expected.script || expected.keyOffset !== action.commissionKeyOffset) {
    throw new WERR_INVALID_PARAMETER('commission', 'match the active storage commission')
  }
}

async function requireSourceOutput (
  storage: StorageProvider,
  beef: Beef,
  txid: string,
  vout: number
): Promise<{ satoshis: number, lockingScript: Script }> {
  let source = beef.findTxid(txid)?.tx
  if (source == null) {
    try {
      beef.mergeBeef(await storage.getBeefForTransaction(txid, { ignoreServices: true }))
      source = beef.findTxid(txid)?.tx
    } catch (_error: unknown) {
      // The normalized invalid-parameter error below keeps the remote API
      // independent of provider-specific lookup failures.
    }
  }
  const output = source?.outputs[vout]
  if (output == null) throw new WERR_INVALID_PARAMETER('manifest', `source output ${txid}.${vout}`)
  return {
    satoshis: Validation.validateSatoshis(output.satoshis, 'source output satoshis'),
    lockingScript: output.lockingScript
  }
}

async function materializeActionScripts (
  storage: StorageProvider,
  batch: TableActionBatch,
  manifest: ActionBatchManifest,
  action: ActionBatchCommitAction
): Promise<ActionBatchCommitAction> {
  if (action.lockingScriptDigests == null) return action
  if (action.lockingScriptDigests.length !== action.plan.outputs.length) {
    throw new WERR_INVALID_PARAMETER('lockingScriptDigests', 'align with planned outputs')
  }
  const scripts: string[] = []
  for (let index = 0; index < action.plan.outputs.length; index++) {
    const digest = action.lockingScriptDigests[index]
    scripts.push(digest == null
      ? action.plan.outputs[index].lockingScript
      : asString(await resolveManifestBytes(
        storage,
        batch,
        manifest.inlineBlobs?.[digest],
        digest,
        `locking script ${index}`,
        manifest.blobChunks?.[digest]
      )))
  }
  return {
    ...action,
    plan: {
      ...action.plan,
      outputs: action.plan.outputs.map((output, index) => ({ ...output, lockingScript: scripts[index] }))
    },
    metadata: {
      ...action.metadata,
      outputs: action.metadata.outputs.map((output, index) => ({ ...output, lockingScript: scripts[index] }))
    }
  }
}

export async function validateManifestActions (
  storage: StorageProvider,
  batch: TableActionBatch,
  manifest: ActionBatchManifest
): Promise<{ actions: ValidatedBatchAction[], dependencyBeef: number[] }> {
  const dependencyBeef = await resolveManifestBytes(
    storage,
    batch,
    manifest.dependencyBeef ?? (manifest.dependencyBeefDigest == null
      ? undefined
      : manifest.inlineBlobs?.[manifest.dependencyBeefDigest]),
    manifest.dependencyBeefDigest,
    'dependencyBeef',
    manifest.dependencyBeefDigest == null ? undefined : manifest.blobChunks?.[manifest.dependencyBeefDigest]
  )
  if (manifest.actions.length === 0) {
    throw new WERR_INVALID_PARAMETER('actions', 'contain at least one signed action')
  }
  const beef = dependencyBeef.length === 0 ? new Beef() : Beef.fromBinary(dependencyBeef)
  const batchTxids = new Set(manifest.actions.map(action => action.txid))
  const seenTxids = new Set<string>()
  const seenReferences = new Set<string>()
  const spentOutpoints = new Set<string>()
  const actions: ValidatedBatchAction[] = []
  for (const compactAction of manifest.actions) {
    const action = await materializeActionScripts(storage, batch, manifest, compactAction)
    if (seenTxids.has(action.txid)) throw new WERR_INVALID_PARAMETER('actions', 'unique txids')
    if (seenReferences.has(action.reference)) throw new WERR_INVALID_PARAMETER('actions', 'unique references')
    if (action.reference !== action.plan.reference) throw new WERR_INVALID_PARAMETER('reference', 'match plan')
    validateActionMetadata(action)
    validateActionCommission(storage, action)
    const rawTx = await resolveManifestBytes(
      storage,
      batch,
      action.rawTx ?? (action.rawTxDigest == null ? undefined : manifest.inlineBlobs?.[action.rawTxDigest]),
      action.rawTxDigest,
      `rawTx ${action.txid}`,
      action.rawTxDigest == null ? undefined : manifest.blobChunks?.[action.rawTxDigest]
    )
    const tx = Transaction.fromBinary(rawTx)
    if (tx.id('hex') !== action.txid) throw new WERR_INVALID_PARAMETER('txid', 'match raw transaction')
    if (!(await storage.getServices().nLockTimeIsFinal(tx))) {
      throw new WERR_INVALID_PARAMETER('transaction', 'final nLockTime and sequence values')
    }
    if (tx.version !== action.plan.version || tx.lockTime !== action.plan.lockTime) {
      throw new WERR_INVALID_PARAMETER('transaction', 'match planned version and lockTime')
    }
    if (tx.inputs.length !== action.plan.inputs.length || tx.outputs.length !== action.plan.outputs.length) {
      throw new WERR_INVALID_PARAMETER('transaction', 'match planned input and output counts')
    }
    if (!action.plan.inputs.every((input, index) => input.vin === index)) {
      throw new WERR_INVALID_PARAMETER('inputs', 'complete sequential vin mappings')
    }
    const outputVouts = action.plan.outputs.map(output => output.vout).sort((a, b) => a - b)
    if (!outputVouts.every((vout, index) => vout === index)) {
      throw new WERR_INVALID_PARAMETER('outputs', 'complete sequential vout mappings')
    }
    const expectedNoSendChange = action.metadata.isNoSend
      ? action.plan.outputs.filter(output => output.purpose === 'change').map(output => output.vout)
      : undefined
    if (!sameNumbers(action.plan.noSendChangeOutputVouts, expectedNoSendChange)) {
      throw new WERR_INVALID_PARAMETER('noSendChangeOutputVouts', 'match planned change outputs')
    }
    for (const planned of action.plan.inputs) {
      const input = tx.inputs[planned.vin]
      if (input == null || input.sourceTXID !== planned.sourceTxid || input.sourceOutputIndex !== planned.sourceVout) {
        throw new WERR_INVALID_PARAMETER('inputs', 'match planned transaction outpoints')
      }
      const source = await requireSourceOutput(storage, beef, planned.sourceTxid, planned.sourceVout)
      if (source.satoshis !== planned.sourceSatoshis || source.lockingScript.toHex() !== planned.sourceLockingScript) {
        throw new WERR_INVALID_PARAMETER('inputs', 'match proven source outputs')
      }
    }
    for (const input of tx.inputs) {
      const sourceTxid = input.sourceTXID
      if (sourceTxid == null) throw new WERR_INVALID_PARAMETER('input.sourceTXID', 'valid')
      const outpoint = `${sourceTxid}.${input.sourceOutputIndex}`
      if (spentOutpoints.has(outpoint)) throw new WERR_INVALID_PARAMETER('actions', `not double spend ${outpoint}`)
      spentOutpoints.add(outpoint)
      if (batchTxids.has(sourceTxid) && !seenTxids.has(sourceTxid)) {
        throw new WERR_INVALID_PARAMETER('actions', 'topologically ordered')
      }
    }
    const inputSatoshis = action.plan.inputs.reduce((sum, input) => sum + input.sourceSatoshis, 0)
    const outputSatoshis = tx.outputs.reduce(
      (sum, output) => sum + Validation.validateSatoshis(output.satoshis, 'transaction output satoshis'),
      0
    )
    const feePaid = inputSatoshis - outputSatoshis
    const feeRate = validateStorageFeeModel(storage.feeModel).value ?? 0
    if (feePaid < Math.ceil(rawTx.length * feeRate / 1000)) {
      throw new WERR_INVALID_PARAMETER('transaction fee', 'meet the active storage fee model')
    }
    for (const planned of action.plan.outputs) {
      const transactionOutput = tx.outputs[planned.vout]
      if (transactionOutput == null || transactionOutput.satoshis !== planned.satoshis ||
        (planned.lockingScript === ''
          ? planned.providedBy !== 'storage' || planned.purpose !== 'change'
          : transactionOutput.lockingScript.toHex() !== planned.lockingScript)) {
        throw new WERR_INVALID_PARAMETER('outputs', 'match planned transaction outputs')
      }
    }
    const inputBeef = asArray(beefForTxids(
      beef,
      action.plan.inputs.map(input => input.sourceTxid)
    ).toUint8Array())
    beef.mergeRawTx(rawTx)
    seenTxids.add(action.txid)
    seenReferences.add(action.reference)
    actions.push({ action, tx, rawTx, inputBeef })
  }
  for (const { action } of actions) verifyUnlockScripts(action.txid, beef)
  if (!(await beef.verify(await storage.getServices().getChainTracker(), true))) {
    throw new WERR_INVALID_PARAMETER('manifest', 'valid dependency graph')
  }
  return { actions, dependencyBeef }
}
