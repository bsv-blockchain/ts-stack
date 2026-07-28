import { Beef, Hash, Script, Transaction, Utils, Validation } from '@bsv/sdk'
import type { ActionBatchCommitAction, ActionBatchManifest } from '../../sdk/ActionBatch.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { verifyUnlockScriptsBatch } from '../../signer/methods/verifyUnlockScripts'
import { actionBatchBlobDigest } from '../../utility/actionBatchDigest'
import { beefForTxids } from '../../utility/beefForTxids'
import { asString, asUint8Array } from '../../utility/utilityHelpers.noBuffer'
import type { StorageProvider } from '../StorageProvider'
import { validateStorageFeeModel } from '../StorageProvider'
import type { TableActionBatch, TableActionBatchBlob } from '../schema/tables/TableActionBatch'
import { maxPossibleSatoshis } from './generateChange'
import { lockScriptWithKeyOffsetFromPubKey } from './offsetKey'
import { manifestPhysicalDigests } from './actionBatchBlobs'

export interface ValidatedBatchAction {
  action: ActionBatchCommitAction
  tx: Transaction
  rawTx: Uint8Array
  /** Proof frontier for inputs outside this atomic batch. */
  externalInputBeef: Uint8Array
}

async function resolveManifestBytes(
  blobs: ReadonlyMap<string, TableActionBatchBlob>,
  inline: number[] | Uint8Array | undefined,
  digest: string | undefined,
  name: string,
  chunkDigests?: string[]
): Promise<Uint8Array> {
  if (inline != null) {
    const bytes = asUint8Array(inline)
    if (digest != null && actionBatchBlobDigest(bytes) !== digest) {
      throw new WERR_INVALID_PARAMETER(name, 'match digest')
    }
    return bytes
  }
  if (digest == null) throw new WERR_INVALID_PARAMETER(name, 'inline bytes or digest')
  if (chunkDigests != null) {
    if (chunkDigests.length === 0) throw new WERR_INVALID_PARAMETER(name, 'one or more blob chunks')
    const chunks: Array<number[] | Uint8Array> = []
    const logicalHash = new Hash.SHA256()
    let totalBytes = 0
    for (const chunkDigest of chunkDigests) {
      const chunk = blobs.get(chunkDigest)
      if (chunk == null) throw new WERR_INVALID_OPERATION(`missing action batch blob ${chunkDigest}`)
      if (actionBatchBlobDigest(chunk.bytes) !== chunkDigest) {
        throw new WERR_INVALID_OPERATION(`corrupt action batch blob ${chunkDigest}`)
      }
      totalBytes += chunk.bytes.length
      if (!Number.isSafeInteger(totalBytes)) {
        throw new WERR_INVALID_OPERATION(`action batch ${name} exceeds this runtime's addressable memory`)
      }
      chunks.push(chunk.bytes)
      logicalHash.update(chunk.bytes)
    }
    if (Utils.toHex(logicalHash.digest()) !== digest) {
      throw new WERR_INVALID_PARAMETER(name, 'chunks matching digest')
    }
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(totalBytes)
    } catch (error: unknown) {
      if (error instanceof RangeError) {
        throw new WERR_INVALID_OPERATION(`action batch ${name} cannot be assembled in this runtime`)
      }
      throw error
    }
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  }
  const blob = blobs.get(digest)
  if (blob == null) throw new WERR_INVALID_OPERATION(`missing action batch blob ${digest}`)
  if (actionBatchBlobDigest(blob.bytes) !== digest) {
    throw new WERR_INVALID_OPERATION(`corrupt action batch blob ${digest}`)
  }
  return blob.bytes instanceof Uint8Array ? blob.bytes : Uint8Array.from(blob.bytes)
}

function sameStrings(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? []
  const b = right ?? []
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameNumbers(left: number[] | undefined, right: number[] | undefined): boolean {
  const a = left ?? []
  const b = right ?? []
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function validateActionInputs(action: ActionBatchCommitAction): void {
  if (action.metadata.inputs.length > action.plan.inputs.length) {
    throw new WERR_INVALID_PARAMETER('metadata.inputs', 'align with planned inputs')
  }
  for (let index = 0; index < action.metadata.inputs.length; index++) {
    const requested = action.metadata.inputs[index]
    const planned = action.plan.inputs[index]
    if (
      planned == null ||
      planned.providedBy === 'storage' ||
      requested.outpoint.txid !== planned.sourceTxid ||
      requested.outpoint.vout !== planned.sourceVout ||
      requested.unlockingScriptLength !== planned.unlockingScriptLength ||
      requested.inputDescription !== planned.spendingDescription
    ) {
      throw new WERR_INVALID_PARAMETER('metadata.inputs', 'match planned explicit inputs')
    }
  }
  if (action.plan.inputs.slice(action.metadata.inputs.length).some(input => input.providedBy !== 'storage')) {
    throw new WERR_INVALID_PARAMETER('metadata.inputs', 'represent every caller-provided input')
  }
}

function requestedOutputMatches(
  requested: ActionBatchCommitAction['metadata']['outputs'][number],
  planned: ActionBatchCommitAction['plan']['outputs'][number]
): boolean {
  const satoshisMatch = requested.satoshis === maxPossibleSatoshis || requested.satoshis === planned.satoshis
  return (
    planned.providedBy === 'you' &&
    satoshisMatch &&
    requested.lockingScript === planned.lockingScript &&
    requested.outputDescription === planned.outputDescription &&
    requested.basket === planned.basket &&
    requested.customInstructions === planned.customInstructions &&
    sameStrings(requested.tags, planned.tags)
  )
}

function validateAdditionalPlannedOutput(
  action: ActionBatchCommitAction,
  planned: ActionBatchCommitAction['plan']['outputs'][number]
): void {
  const isChange = planned.providedBy === 'storage' && planned.purpose === 'change'
  const isCommission =
    planned.providedBy === 'storage' &&
    (planned.purpose === 'storage-commission' || planned.purpose === 'service-charge')
  if (!isChange && !isCommission) {
    throw new WERR_INVALID_PARAMETER('plan.outputs', 'only requested, change, or commission outputs')
  }
  if (
    isChange &&
    (planned.basket !== 'default' ||
      planned.tags.length !== 0 ||
      planned.outputDescription !== '' ||
      planned.customInstructions != null ||
      planned.lockingScript !== '' ||
      planned.derivationSuffix == null ||
      action.plan.derivationPrefix.length === 0)
  ) {
    throw new WERR_INVALID_PARAMETER('plan.outputs', 'canonical wallet-managed change metadata')
  }
  if (isCommission && (planned.basket != null || planned.tags.length !== 0 || planned.customInstructions != null)) {
    throw new WERR_INVALID_PARAMETER('plan.outputs', 'canonical storage commission metadata')
  }
}

function validateActionOutputs(action: ActionBatchCommitAction): void {
  if (action.metadata.outputs.length > action.plan.outputs.length) {
    throw new WERR_INVALID_PARAMETER('metadata.outputs', 'align with planned outputs')
  }
  for (let index = 0; index < action.metadata.outputs.length; index++) {
    const requested = action.metadata.outputs[index]
    const planned = action.plan.outputs[index]
    if (planned == null) {
      throw new WERR_INVALID_PARAMETER('metadata.outputs', 'match planned requested outputs')
    }
    if (!requestedOutputMatches(requested, planned)) {
      throw new WERR_INVALID_PARAMETER('metadata.outputs', 'match planned requested outputs')
    }
  }
  for (const planned of action.plan.outputs.slice(action.metadata.outputs.length)) {
    validateAdditionalPlannedOutput(action, planned)
  }
}

function validateActionMetadata(action: ActionBatchCommitAction): void {
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

function validateActionCommission(storage: StorageProvider, action: ActionBatchCommitAction): void {
  const commissions = action.plan.outputs.filter(
    output => output.purpose === 'storage-commission' || output.purpose === 'service-charge'
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
  const expected = lockScriptWithKeyOffsetFromPubKey(storage.commissionPubKeyHex, action.commissionKeyOffset)
  if (
    commission.providedBy !== 'storage' ||
    commission.satoshis !== storage.commissionSatoshis ||
    commission.lockingScript !== expected.script ||
    expected.keyOffset !== action.commissionKeyOffset
  ) {
    throw new WERR_INVALID_PARAMETER('commission', 'match the active storage commission')
  }
}

async function requireSourceOutput(
  storage: StorageProvider,
  beef: Beef,
  txid: string,
  vout: number
): Promise<{ satoshis: number; lockingScript: Script }> {
  let source = beef.findTxid(txid)?.tx
  if (source == null) {
    try {
      beef.mergeBeef(await storage.getBeefForTransaction(txid, { ignoreServices: true }))
      source = beef.findTxid(txid)?.tx
    } catch {
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

async function materializeActionScripts(
  blobs: ReadonlyMap<string, TableActionBatchBlob>,
  manifest: ActionBatchManifest,
  action: ActionBatchCommitAction,
  tx: Transaction
): Promise<ActionBatchCommitAction> {
  if (action.lockingScriptDigests == null) return action
  if (action.lockingScriptDigests.length !== action.plan.outputs.length) {
    throw new WERR_INVALID_PARAMETER('lockingScriptDigests', 'align with planned outputs')
  }
  const scripts: string[] = []
  for (let index = 0; index < action.plan.outputs.length; index++) {
    const digest = action.lockingScriptDigests[index]
    if (action.deriveLockingScripts === true) {
      const output = tx.outputs[action.plan.outputs[index].vout]
      if (output == null) {
        throw new WERR_INVALID_PARAMETER('lockingScriptDigests', 'align with transaction outputs')
      }
      const bytes = output.lockingScript.toUint8Array()
      if (digest == null || actionBatchBlobDigest(bytes) !== digest) {
        throw new WERR_INVALID_PARAMETER('lockingScriptDigests', 'match transaction output scripts')
      }
      scripts.push(output.lockingScript.toHex())
    } else {
      scripts.push(
        digest == null
          ? action.plan.outputs[index].lockingScript
          : asString(
              await resolveManifestBytes(
                blobs,
                manifest.inlineBlobs?.[digest],
                digest,
                `locking script ${index}`,
                manifest.blobChunks?.[digest]
              )
            )
      )
    }
  }
  return {
    ...action,
    plan: {
      ...action.plan,
      outputs: action.plan.outputs.map((output, index) => ({
        ...output,
        // Wallet-managed change is intentionally represented by derivation
        // metadata in the canonical plan, even though its transaction output
        // script participates in the compact-manifest digest check above.
        lockingScript: output.purpose === 'change' ? '' : scripts[index]
      }))
    },
    metadata: {
      ...action.metadata,
      outputs: action.metadata.outputs.map((output, index) => ({ ...output, lockingScript: scripts[index] }))
    }
  }
}

export async function validateManifestActions(
  storage: StorageProvider,
  batch: TableActionBatch,
  manifest: ActionBatchManifest
): Promise<{ actions: ValidatedBatchAction[]; dependencyBeef: Uint8Array; beef: Beef }> {
  const blobRecords = await storage.findActionBatchBlobRecords(
    batch.actionBatchId,
    manifestPhysicalDigests(manifest)
  )
  const blobs = new Map(blobRecords.map(blob => [blob.digest, blob]))
  const dependencyBeef = await resolveManifestBytes(
    blobs,
    manifest.dependencyBeef ??
      (manifest.dependencyBeefDigest == null ? undefined : manifest.inlineBlobs?.[manifest.dependencyBeefDigest]),
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
    const rawTx = await resolveManifestBytes(
      blobs,
      compactAction.rawTx ?? (compactAction.rawTxDigest == null ? undefined : manifest.inlineBlobs?.[compactAction.rawTxDigest]),
      compactAction.rawTxDigest,
      `rawTx ${compactAction.txid}`,
      compactAction.rawTxDigest == null ? undefined : manifest.blobChunks?.[compactAction.rawTxDigest]
    )
    const tx = Transaction.fromBinary(rawTx)
    const action = await materializeActionScripts(blobs, manifest, compactAction, tx)
    if (seenTxids.has(action.txid)) throw new WERR_INVALID_PARAMETER('actions', 'unique txids')
    if (seenReferences.has(action.reference)) throw new WERR_INVALID_PARAMETER('actions', 'unique references')
    if (action.reference !== action.plan.reference) throw new WERR_INVALID_PARAMETER('reference', 'match plan')
    validateActionMetadata(action)
    validateActionCommission(storage, action)
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
      if (input?.sourceTXID !== planned.sourceTxid || input.sourceOutputIndex !== planned.sourceVout) {
        throw new WERR_INVALID_PARAMETER('inputs', 'match planned transaction outpoints')
      }
      const source = await requireSourceOutput(storage, beef, planned.sourceTxid, planned.sourceVout)
      if (source.satoshis !== planned.sourceSatoshis ||
        (planned.sourceLockingScript != null && source.lockingScript.toHex() !== planned.sourceLockingScript)) {
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
    if (feePaid < Math.ceil((rawTx.length * feeRate) / 1000)) {
      throw new WERR_INVALID_PARAMETER('transaction fee', 'meet the active storage fee model')
    }
    for (const planned of action.plan.outputs) {
      const transactionOutput = tx.outputs[planned.vout]
      if (
        transactionOutput == null ||
        transactionOutput.satoshis !== planned.satoshis ||
        (planned.lockingScript === ''
          ? planned.providedBy !== 'storage' || planned.purpose !== 'change'
          : transactionOutput.lockingScript.toHex() !== planned.lockingScript)
      ) {
        throw new WERR_INVALID_PARAMETER('outputs', 'match planned transaction outputs')
      }
    }
    const externalInputBeef = beefForTxids(
      beef,
      action.plan.inputs
        .map(input => input.sourceTxid)
        .filter(txid => !batchTxids.has(txid))
    ).toUint8Array()
    beef.mergeRawTx(rawTx)
    seenTxids.add(action.txid)
    seenReferences.add(action.reference)
    actions.push({ action, tx, rawTx, externalInputBeef })
  }
  await verifyUnlockScriptsBatch(
    actions.map(({ action }) => action.txid),
    beef,
    storage.scriptVerifier
  )
  if (!(await beef.verify(await storage.getServices().getChainTracker(), true))) {
    throw new WERR_INVALID_PARAMETER('manifest', 'valid dependency graph')
  }
  return { actions, dependencyBeef, beef }
}
