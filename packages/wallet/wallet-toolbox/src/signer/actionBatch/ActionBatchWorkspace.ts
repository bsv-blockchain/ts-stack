import {
  Beef,
  ListActionsResult,
  ListOutputsResult,
  Transaction,
  Validation
} from '@bsv/sdk'
import type { PendingSignAction, Wallet } from '../../Wallet'
import {
  ActionBatchCommitAction,
  ActionBatchManifest,
  BeginActionBatchResult,
  CommitActionBatchResult,
  StorageCapabilities
} from '../../sdk/ActionBatch.interfaces'
import { StorageCreateActionResult, StorageProcessActionResults } from '../../sdk/WalletStorage.interfaces'
import { WERR_INSUFFICIENT_FUNDS, WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { randomBytesBase64 } from '../../utility/utilityHelpers'
import { asArray, asString } from '../../utility/utilityHelpers.noBuffer'
import {
  isListActionsSpecOp,
  specOpFailedActions,
  specOpNoSendActions,
  specOpWalletBalance,
  specOpWalletManagedUtxos
} from '../../sdk/types'
import {
  actionBatchBlobDigest,
  actionBatchManifestDigest
} from '../../utility/actionBatchDigest'
import {
  ActionBatchPlannedAction,
  ActionBatchPlannerState,
  addPlannerOutputs,
  mergePlannerBeef,
  planAction,
  plannerOutputLockingScript,
  stageTransactionOutputs
} from './ActionBatchPlanner'
import { beefForTxids } from '../../utility/beefForTxids'

export type ActionBatchMode = 'auto' | 'legacy'

interface PendingBatchPlan {
  args: Validation.ValidCreateActionArgs
  planned: ActionBatchPlannedAction
}

interface UploadBlob {
  digest: string
  bytes: number[]
}

function mergeUnique (values: string[]): string[] {
  return [...new Set(values)]
}

function nextGeometricTarget (value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value * 2)
}

export function additionalFundingTarget (error: WERR_INSUFFICIENT_FUNDS): number {
  return error.moreSatoshisNeeded
}

export function fundingRunwayExtension (
  runwayTarget: number,
  ewmaConfirmedInputs: number,
  ewmaConfirmedSatoshis: number,
  availableConfirmed: Array<{ satoshis: number }>
): { nextRunwayTarget: number, requestedOutputs: number, targetSatoshis: number } | undefined {
  const availableConfirmedCount = availableConfirmed.length
  const availableConfirmedSatoshis = availableConfirmed
    .reduce((sum, output) => sum + output.satoshis, 0)
  const predictedByInputs = availableConfirmedCount / Math.max(1, ewmaConfirmedInputs)
  const predictedBySatoshis = ewmaConfirmedSatoshis > 0
    ? availableConfirmedSatoshis / ewmaConfirmedSatoshis
    : Number.POSITIVE_INFINITY
  if (Math.min(predictedByInputs, predictedBySatoshis) >= 2) return undefined
  const nextRunwayTarget = nextGeometricTarget(runwayTarget)
  return {
    nextRunwayTarget,
    requestedOutputs: Math.max(
      1,
      Math.ceil(nextRunwayTarget * ewmaConfirmedInputs) - availableConfirmedCount
    ),
    targetSatoshis: Math.max(
      1,
      nextRunwayTarget * ewmaConfirmedSatoshis - availableConfirmedSatoshis
    )
  }
}

function makePlannerState (
  begin: BeginActionBatchResult,
  firstAction: Validation.ValidCreateActionArgs
): ActionBatchPlannerState {
  const sharedBeef = new Beef()
  if (begin.inputBeef != null) sharedBeef.mergeBeef(begin.inputBeef)
  if (firstAction.inputBEEF != null) sharedBeef.mergeBeef(firstAction.inputBEEF)
  for (const output of [...begin.reservedOutputs, ...begin.explicitOutputs]) {
    if (output.sourceTransaction != null) sharedBeef.mergeRawTx(output.sourceTransaction)
  }
  const state: ActionBatchPlannerState = {
    begin,
    sharedBeef,
    reserved: new Map(),
    explicit: new Map(),
    staged: new Map(),
    discardedStagedTxids: new Set(),
    consumed: new Set(),
    estimatedChangeCount: begin.availableChangeCount
  }
  addPlannerOutputs(state.reserved, begin.reservedOutputs, begin.changeBasket.name)
  addPlannerOutputs(state.explicit, begin.explicitOutputs)
  return state
}

class ActionBatchWorkspace {
  readonly batchId: string
  readonly state: ActionBatchPlannerState
  readonly planned = new Map<string, PendingBatchPlan>()
  readonly actions: ActionBatchCommitAction[] = []
  readonly lockingScripts = new Map<string, string>()

  private ewmaConfirmedInputs = 1
  private ewmaConfirmedSatoshis = 0
  private hasConfirmedSample = false
  private runwayTarget = 4
  private extension?: Promise<void>
  private renewal?: Promise<void>
  private expiresAt: number
  private committed = false

  constructor (
    private readonly wallet: Wallet,
    begin: BeginActionBatchResult,
    firstAction: Validation.ValidCreateActionArgs,
    private readonly capabilities: NonNullable<StorageCapabilities['actionBatch']>
  ) {
    this.batchId = begin.batchId
    this.state = makePlannerState(begin, firstAction)
    this.expiresAt = Date.parse(begin.expiresAt)
  }

  ownsReference (reference: string): boolean {
    if (this.planned.has(reference)) return true
    if (this.actions.some(action => action.reference === reference || action.txid === reference)) return true
    return Object.entries(this.wallet.pendingSignActions)
      .some(([pendingReference, pending]) =>
        this.planned.has(pendingReference) && pending.tx.id('hex') === reference
      )
  }

  get isEmpty (): boolean {
    return this.planned.size === 0 && this.actions.length === 0
  }

  overlayListActions (
    persisted: ListActionsResult,
    args: Validation.ValidListActionsArgs
  ): ListActionsResult {
    if (args.labels.includes(specOpFailedActions)) return persisted
    const controlLabels = new Set(args.labels.includes(specOpNoSendActions) ? ['abort'] : [])
    const ordinaryLabels = args.labels.filter(label => !isListActionsSpecOp(label) && !controlLabels.has(label))
    const staged = this.actions
      .filter(action => {
        if (ordinaryLabels.length === 0) return true
        const matches = ordinaryLabels.filter(label => action.metadata.labels.includes(label)).length
        return args.labelQueryMode === 'all' ? matches === ordinaryLabels.length : matches > 0
      })
      .map(action => {
        const tx = this.state.sharedBeef.findTxid(action.txid)?.tx
        if (tx == null) throw new WERR_INVALID_OPERATION(`missing staged transaction ${action.txid}`)
        const managedInputSatoshis = action.plan.inputs
          .filter(input => input.vin >= action.metadata.inputs.length)
          .reduce((sum, input) => sum + input.sourceSatoshis, 0)
        const changeOutputSatoshis = action.plan.outputs
          .filter(output => output.purpose === 'change')
          .reduce((sum, output) => sum + output.satoshis, 0)
        return {
          txid: action.txid,
          satoshis: changeOutputSatoshis - managedInputSatoshis,
          status: 'nosend' as const,
          isOutgoing: true,
          description: action.metadata.description,
          labels: args.includeLabels ? action.metadata.labels : undefined,
          version: tx.version,
          lockTime: tx.lockTime,
          inputs: args.includeInputs
            ? action.plan.inputs.map(input => ({
                sourceOutpoint: `${input.sourceTxid}.${input.sourceVout}`,
                sourceSatoshis: input.sourceSatoshis,
                sourceLockingScript: args.includeInputSourceLockingScripts ? input.sourceLockingScript : undefined,
                unlockingScript: args.includeInputUnlockingScripts
                  ? tx.inputs[input.vin]?.unlockingScript?.toHex()
                  : undefined,
                inputDescription: input.spendingDescription ?? '',
                sequenceNumber: tx.inputs[input.vin]?.sequence ?? 0
              }))
            : undefined,
          outputs: args.includeOutputs
            ? action.plan.outputs.map(output => ({
                satoshis: output.satoshis,
                lockingScript: args.includeOutputLockingScripts
                  ? tx.outputs[output.vout]?.lockingScript.toHex()
                  : undefined,
                spendable: output.purpose !== 'storage-commission',
                customInstructions: undefined,
                tags: output.tags,
                outputIndex: output.vout,
                outputDescription: output.outputDescription,
                basket: output.basket ?? ''
              }))
            : undefined
        }
      })
    const actions = [...persisted.actions, ...staged]
    return {
      totalActions: persisted.totalActions + staged.length,
      actions: actions.slice(args.offset, args.offset + args.limit)
    }
  }

  overlayListOutputs (
    persisted: ListOutputsResult,
    args: Validation.ValidListOutputsArgs
  ): ListOutputsResult {
    const isBalance = args.basket === specOpWalletBalance || args.tags.includes(specOpWalletBalance)
    const managedOnly = args.basket === specOpWalletManagedUtxos || isBalance
    const consumed = this.state.consumed
    const stagedLabels = new Map(this.actions.map(action => [action.txid, action.metadata.labels]))
    const staged = [...this.state.staged.entries()]
      .filter(([outpoint, output]) => {
        if (consumed.has(outpoint)) return false
        if (managedOnly) return output.change
        if (output.basketName !== args.basket) return false
        const tags = output.tags ?? []
        if (args.tags.length === 0) return true
        const matches = args.tags.filter(tag => tags.includes(tag)).length
        return args.tagQueryMode === 'all' ? matches === args.tags.length : matches > 0
      })
      .map(([outpoint, output]) => ({
        satoshis: output.satoshis,
        lockingScript: args.includeLockingScripts
          ? asString(plannerOutputLockingScript(this.state, output))
          : undefined,
        spendable: true,
        customInstructions: args.includeCustomInstructions ? output.customInstructions : undefined,
        tags: args.includeTags ? output.tags ?? [] : undefined,
        outpoint,
        labels: args.includeLabels && output.txid != null ? stagedLabels.get(output.txid) ?? [] : undefined
      }))

    if (isBalance) {
      const consumedConfirmed = [...this.state.reserved.entries()]
        .filter(([outpoint]) => consumed.has(outpoint))
        .reduce((sum, [, output]) => sum + output.satoshis, 0)
      return {
        totalOutputs: persisted.totalOutputs - consumedConfirmed + staged.reduce((sum, output) => sum + output.satoshis, 0),
        outputs: []
      }
    }

    const persistedUnconsumed = persisted.outputs.filter(output => !consumed.has(output.outpoint))
    const outputs = [
      ...persistedUnconsumed,
      ...staged
    ]
    const ordered = args.offset < 0 ? [...outputs].reverse() : outputs
    const offset = args.offset < 0 ? Math.max(0, -args.offset - 1) : args.offset
    const result: ListOutputsResult = {
      totalOutputs: persisted.totalOutputs - (persisted.outputs.length - persistedUnconsumed.length) + staged.length,
      outputs: ordered.slice(offset, offset + args.limit)
    }
    if (args.includeTransactions) {
      const beef = new Beef()
      if (persisted.BEEF != null) beef.mergeBeef(persisted.BEEF)
      beef.mergeBeef(this.state.sharedBeef)
      for (const txid of args.knownTxids) if (beef.findTxid(txid) != null) beef.makeTxidOnly(txid)
      result.BEEF = beef.toUint8Array()
    }
    return result
  }

  private mergeExtension (
    extension: {
      reservedOutputs: BeginActionBatchResult['reservedOutputs']
      explicitOutputs: BeginActionBatchResult['explicitOutputs']
      inputBeef?: number[] | Uint8Array
    }
  ): void {
    for (const output of [...extension.reservedOutputs, ...extension.explicitOutputs]) {
      if (output.sourceTransaction != null) {
        this.state.sharedBeef.mergeRawTx(output.sourceTransaction)
      }
    }
    addPlannerOutputs(this.state.reserved, extension.reservedOutputs, this.state.begin.changeBasket.name)
    addPlannerOutputs(this.state.explicit, extension.explicitOutputs)
    if (extension.inputBeef != null) {
      this.state.sharedBeef.mergeBeef(extension.inputBeef)
    }
  }

  private missingExplicitOutpoints (args: Validation.ValidCreateActionArgs): Array<{ txid: string, vout: number }> {
    return [...args.inputs.map(input => input.outpoint), ...args.options.noSendChange]
      .filter(outpoint => {
        const key = `${outpoint.txid}.${outpoint.vout}`
        return !this.state.staged.has(key) && !this.state.explicit.has(key) &&
          !this.state.reserved.has(key) && (this.state.discardedStagedTxids.has(outpoint.txid) ||
            this.state.sharedBeef.findTxid(outpoint.txid)?.tx == null)
      })
  }

  private async extend (
    targetSatoshis: number,
    requestedOutputs: number,
    explicitOutpoints: Array<{ txid: string, vout: number }>,
    includeSourceTransactions: boolean
  ): Promise<{ outputCount: number, satoshis: number }> {
    const extension = await this.wallet.storage.extendActionBatch({
      batchId: this.batchId,
      targetSatoshis: Math.max(1, Math.ceil(targetSatoshis)),
      requestedOutputs: Math.max(1, Math.ceil(requestedOutputs)),
      explicitOutpoints,
      includeSourceTransactions
    })
    this.mergeExtension(extension)
    this.expiresAt = Date.parse(extension.expiresAt)
    return {
      outputCount: extension.reservedOutputs.length,
      satoshis: extension.reservedOutputs.reduce((sum, output) => sum + output.satoshis, 0)
    }
  }

  private async renewIfNeeded (): Promise<void> {
    if (Date.now() >= this.expiresAt) return
    const renewAt = this.expiresAt - this.capabilities.leaseMs * 0.2
    if (Date.now() < renewAt) return
    this.renewal ??= this.wallet.storage.renewActionBatch(this.batchId)
      .then(result => { this.expiresAt = Date.parse(result.expiresAt) })
      .finally(() => { this.renewal = undefined })
    await this.renewal
  }

  async plan (args: Validation.ValidCreateActionArgs): Promise<StorageCreateActionResult> {
    if (this.committed) throw new WERR_INVALID_OPERATION('action batch is already committed')
    await this.renewIfNeeded()
    if (this.extension != null) await this.extension
    if (args.inputBEEF != null) {
      this.state.sharedBeef.mergeBeef(args.inputBEEF)
    }
    const missing = this.missingExplicitOutpoints(args)
    if (missing.length > 0) await this.extend(1, 1, missing, args.isSignAction)

    let planned: ActionBatchPlannedAction | undefined
    let requestedOutputs = 8
    for (;;) {
      try {
        planned = await planAction(this.state, args)
        break
      } catch (error) {
        if (!(error instanceof WERR_INSUFFICIENT_FUNDS)) throw error
        // generateChangeSdk has already credited every unconsumed reservation
        // supplied by planFunding. Only the reported shortfall is additional;
        // requesting totalSatoshisNeeded here double-counts the held pool.
        const target = additionalFundingTarget(error)
        const added = await this.extend(target, requestedOutputs, [], args.isSignAction)
        if (added.outputCount === 0 || added.satoshis === 0) throw error
        requestedOutputs = nextGeometricTarget(requestedOutputs)
      }
    }
    if (planned == null) throw new WERR_INVALID_OPERATION('unable to plan action batch transaction')
    this.planned.set(planned.dcr.reference, { args, planned })
    return planned.dcr
  }

  private updateEwma (plan: PendingBatchPlan): void {
    const confirmed = plan.planned.consumedOutpoints
      .map(outpoint => this.state.reserved.get(outpoint))
      .filter((output): output is NonNullable<typeof output> => output != null)
    if (confirmed.length === 0) return
    const satoshis = confirmed.reduce((sum, output) => sum + output.satoshis, 0)
    if (!this.hasConfirmedSample) {
      this.ewmaConfirmedInputs = confirmed.length
      this.ewmaConfirmedSatoshis = satoshis
      this.hasConfirmedSample = true
      return
    }
    this.ewmaConfirmedInputs = 0.5 * confirmed.length + 0.5 * this.ewmaConfirmedInputs
    this.ewmaConfirmedSatoshis = 0.5 * satoshis + 0.5 * this.ewmaConfirmedSatoshis
  }

  stage (prior: PendingSignAction, processArgs: Validation.ValidProcessActionArgs): void {
    if (this.actions.some(action => action.reference === prior.reference)) return
    const pending = this.planned.get(prior.reference)
    if (pending == null) throw new WERR_INVALID_OPERATION('signed action does not belong to active action batch')
    const txid = prior.tx.id('hex')
    const lockingScriptDigests = prior.dcr.outputs.map(output => {
      if (output.lockingScript.length === 0) return undefined
      const digest = actionBatchBlobDigest(asArray(output.lockingScript))
      this.lockingScripts.set(digest, output.lockingScript)
      return digest
    })
    const compactPlan: StorageCreateActionResult = {
      ...prior.dcr,
      inputBeef: undefined,
      inputs: prior.dcr.inputs.map(input => ({ ...input, sourceTransaction: undefined })),
      outputs: prior.dcr.outputs.map(output => ({ ...output, lockingScript: '' }))
    }
    const action: ActionBatchCommitAction = {
      reference: prior.reference,
      txid,
      lockingScriptDigests,
      plan: compactPlan,
      metadata: {
        description: pending.args.description,
        labels: pending.args.labels,
        isNoSend: processArgs.isNoSend,
        isDelayed: processArgs.isDelayed,
        inputs: pending.args.inputs,
        outputs: pending.args.outputs.map(output => ({ ...output, lockingScript: '' }))
      },
      commissionKeyOffset: pending.planned.commissionKeyOffset
    }
    this.actions.push(action)
    this.updateEwma(pending)
    stageTransactionOutputs(this.state, prior.tx, prior.dcr)
    mergePlannerBeef(this.state, prior.tx)
    this.planned.delete(prior.reference)
    this.scheduleExtensionIfNeeded()
  }

  private scheduleExtensionIfNeeded (): void {
    if (this.extension != null) return
    const availableConfirmed = [...this.state.reserved.entries()]
      .filter(([outpoint]) => !this.state.consumed.has(outpoint))
    const request = fundingRunwayExtension(
      this.runwayTarget,
      this.ewmaConfirmedInputs,
      this.ewmaConfirmedSatoshis,
      availableConfirmed.map(([, output]) => output)
    )
    if (request == null) return
    this.extension = this.extend(request.targetSatoshis, request.requestedOutputs, [], false)
      .then(added => {
        // A failed or partial extension must not geometrically inflate the
        // next request against a runway that the wallet never acquired.
        if (
          added.outputCount >= request.requestedOutputs &&
          added.satoshis >= request.targetSatoshis
        ) {
          this.runwayTarget = request.nextRunwayTarget
        }
      })
      .catch(() => {})
      .finally(() => { this.extension = undefined })
  }

  private buildManifest (sendWith: string[], isDelayed: boolean): { manifest: ActionBatchManifest, uploads: UploadBlob[] } {
    const stagedTxids = new Set(this.actions.map(action => action.txid))
    const externalTxids = this.actions.flatMap(action => action.plan.inputs)
      .map(input => input.sourceTxid)
      .filter(txid => !stagedTxids.has(txid))
    const dependencyBytes = asArray(beefForTxids(this.state.sharedBeef, externalTxids).toUint8Array())
    const rawBytes = this.actions.map(action => {
      const tx = this.state.sharedBeef.findTxid(action.txid)?.tx
      if (tx == null) throw new WERR_INVALID_OPERATION(`missing staged transaction ${action.txid}`)
      return asArray(tx.toUint8Array())
    })
    const blobs = new Map<string, number[]>()
    const addBlob = (bytes: number[]): string => {
      const digest = actionBatchBlobDigest(bytes)
      if (!blobs.has(digest)) blobs.set(digest, bytes)
      return digest
    }
    const actions = this.actions.map((action, index) => {
      return { ...action, rawTx: undefined, rawTxDigest: addBlob(rawBytes[index]) }
    })
    const dependencyBeefDigest = addBlob(dependencyBytes)
    for (const [digest, script] of this.lockingScripts) {
      if (!blobs.has(digest)) blobs.set(digest, asArray(script))
    }
    const totalBytes = [...blobs.values()].reduce((sum, bytes) => sum + bytes.length, 0)
    const useUploads = totalBytes > this.capabilities.maxInlineBytes
    const uploadBlobs = new Map<string, number[]>()
    const blobChunks: Record<string, string[]> = {}
    if (useUploads) {
      const chunkBytes = Math.max(1, this.capabilities.maxBlobBytes)
      for (const [digest, bytes] of blobs) {
        if (bytes.length <= chunkBytes) {
          uploadBlobs.set(digest, bytes)
          continue
        }
        const chunks: string[] = []
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          const chunk = bytes.slice(offset, Math.min(bytes.length, offset + chunkBytes))
          const chunkDigest = actionBatchBlobDigest(chunk)
          chunks.push(chunkDigest)
          if (!uploadBlobs.has(chunkDigest)) uploadBlobs.set(chunkDigest, chunk)
        }
        blobChunks[digest] = chunks
      }
    }
    const withoutDigest: Omit<ActionBatchManifest, 'digest'> = {
      batchId: this.batchId,
      actions,
      dependencyBeefDigest,
      inlineBlobs: useUploads
        ? undefined
        : Object.fromEntries([...blobs].map(([digest, bytes]) => [digest, Uint8Array.from(bytes)])),
      blobChunks: Object.keys(blobChunks).length === 0 ? undefined : blobChunks,
      sendWith: mergeUnique(sendWith),
      isDelayed
    }
    return {
      manifest: { ...withoutDigest, digest: actionBatchManifestDigest(withoutDigest) },
      uploads: [...uploadBlobs].map(([digest, bytes]) => ({ digest, bytes }))
    }
  }

  private async uploadMissing (manifest: ActionBatchManifest, uploads: UploadBlob[]): Promise<void> {
    const prepared = await this.wallet.storage.prepareActionBatchCommit(manifest)
    const missing = new Set(prepared.missingDigests)
    const pending = uploads.filter(upload => missing.has(upload.digest))
    const concurrency = Math.max(1, Math.min(
      prepared.maxConcurrentUploads,
      this.capabilities.maxConcurrentUploads,
      pending.length
    ))
    let cursor = 0
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= pending.length) return
        const upload = pending[index]
        if (upload.bytes.length > prepared.maxBlobBytes) {
          throw new WERR_INVALID_OPERATION(`action batch blob ${upload.digest} exceeds provider limit`)
        }
        await this.wallet.storage.putActionBatchBlob({
          batchId: this.batchId,
          digest: upload.digest,
          bytes: upload.bytes
        })
      }
    }))
  }

  async commit (sendWith: string[], isDelayed: boolean): Promise<CommitActionBatchResult> {
    if (this.extension != null) await this.extension
    await this.renewIfNeeded()
    if (this.planned.size > 0) throw new WERR_INVALID_OPERATION('all two-step actions must be signed before batch commit')
    const { manifest, uploads } = this.buildManifest(sendWith, isDelayed)
    if (uploads.length > 0) await this.uploadMissing(manifest, uploads)
    const result = await this.wallet.storage.commitActionBatch(manifest)
    this.committed = true
    return result
  }

  abortAction (referenceOrTxid: string): boolean {
    let pendingReference: string | undefined
    if (this.planned.has(referenceOrTxid)) {
      pendingReference = referenceOrTxid
    } else {
      pendingReference = Object.entries(this.wallet.pendingSignActions)
        .find(([reference, pending]) =>
          this.planned.has(reference) && pending.tx.id('hex') === referenceOrTxid
        )?.[0]
    }
    const actionIndex = this.actions.findIndex(action =>
      action.reference === referenceOrTxid || action.txid === referenceOrTxid
    )
    const action = actionIndex < 0 ? undefined : this.actions[actionIndex]
    const targetTxid = action?.txid ??
      (pendingReference == null ? undefined : this.wallet.pendingSignActions[pendingReference]?.tx.id('hex'))
    if (targetTxid != null && this.hasDependentAction(targetTxid, action?.reference ?? pendingReference)) {
      throw new WERR_INVALID_OPERATION(
        `cannot abort action ${referenceOrTxid} while another staged action depends on it`
      )
    }
    if (action != null) {
      this.actions.splice(actionIndex, 1)
    } else if (pendingReference != null) {
      this.planned.delete(pendingReference)
      Reflect.deleteProperty(this.wallet.pendingSignActions, pendingReference)
    } else {
      return false
    }
    if (targetTxid != null) this.state.discardedStagedTxids.add(targetTxid)
    this.rebuildStagedState()
    return true
  }

  private hasDependentAction (txid: string, excludedReference: string | undefined): boolean {
    if (this.actions.some(action =>
      action.reference !== excludedReference &&
      action.plan.inputs.some(input => input.sourceTxid === txid)
    )) return true
    return [...this.planned.entries()].some(([reference, pending]) =>
      reference !== excludedReference &&
      pending.planned.dcr.inputs.some(input => input.sourceTxid === txid)
    )
  }

  private rebuildStagedState (): void {
    this.state.consumed.clear()
    this.state.staged.clear()
    this.state.estimatedChangeCount = this.state.begin.availableChangeCount
    this.lockingScripts.clear()

    for (const action of this.actions) {
      const tx = this.state.sharedBeef.findTxid(action.txid)?.tx
      if (tx == null) throw new WERR_INVALID_OPERATION(`missing staged transaction ${action.txid}`)
      for (const input of action.plan.inputs) {
        this.state.consumed.add(`${input.sourceTxid}.${input.sourceVout}`)
      }
      const managedInputCount = action.plan.inputs.length - action.metadata.inputs.length
      const changeOutputCount = action.plan.outputs.filter(output => output.purpose === 'change').length
      this.state.estimatedChangeCount += changeOutputCount - managedInputCount
      stageTransactionOutputs(this.state, tx, action.plan)
      const lockingScriptDigests = action.lockingScriptDigests ?? []
      lockingScriptDigests.forEach((digest, outputIndex) => {
        if (digest == null) return
        const vout = action.plan.outputs[outputIndex]?.vout
        const script = vout == null ? undefined : tx.outputs[vout]?.lockingScript
        if (script == null) throw new WERR_INVALID_OPERATION(`missing staged output script for ${action.txid}.${vout}`)
        this.lockingScripts.set(digest, script.toHex())
      })
    }

    for (const pending of this.planned.values()) {
      for (const outpoint of pending.planned.consumedOutpoints) this.state.consumed.add(outpoint)
      const managedInputCount = pending.planned.dcr.inputs.length - pending.args.inputs.length
      const changeOutputCount = pending.planned.dcr.outputs.filter(output => output.purpose === 'change').length
      this.state.estimatedChangeCount += changeOutputCount - managedInputCount
    }
  }

  async abort (): Promise<void> {
    if (this.committed) return
    await this.wallet.storage.abortActionBatch(this.batchId)
    for (const reference of this.planned.keys()) delete this.wallet.pendingSignActions[reference]
  }
}

export class ActionBatchController {
  private workspace?: ActionBatchWorkspace
  private readonly capabilities = new Map<string, Promise<StorageCapabilities['actionBatch'] | undefined>>()
  private serial: Promise<void> = Promise.resolve()

  constructor (private readonly wallet: Wallet, readonly mode: ActionBatchMode) {}

  get hasWorkspace (): boolean { return this.workspace != null }

  overlayListActions (persisted: ListActionsResult, args: Validation.ValidListActionsArgs): ListActionsResult {
    return this.workspace?.overlayListActions(persisted, args) ?? persisted
  }

  overlayListOutputs (persisted: ListOutputsResult, args: Validation.ValidListOutputsArgs): ListOutputsResult {
    return this.workspace?.overlayListOutputs(persisted, args) ?? persisted
  }

  private async runExclusive<T> (operation: () => Promise<T>): Promise<T> {
    const run = this.serial.then(operation)
    this.serial = run.then(() => {}, () => {})
    return await run
  }

  private async negotiate (): Promise<StorageCapabilities['actionBatch'] | undefined> {
    if (this.mode === 'legacy') return undefined
    const activeStore = this.wallet.storage.getActiveStore()
    let capabilities = this.capabilities.get(activeStore)
    if (capabilities == null) {
      capabilities = this.wallet.storage.getCapabilities()
        .then(result => result.actionBatch?.version === 1 ? result.actionBatch : undefined)
        .catch(() => undefined)
      this.capabilities.set(activeStore, capabilities)
    }
    return await capabilities
  }

  private async begin (args: Validation.ValidCreateActionArgs): Promise<ActionBatchWorkspace | undefined> {
    if (args.inputs.length > 8) return undefined
    const capabilities = await this.negotiate()
    if (capabilities == null) return undefined
    const batchId = randomBytesBase64(24)
    const begin = await this.wallet.storage.beginActionBatch({
      batchId,
      firstAction: { ...args, logger: undefined }
    })
    this.workspace = new ActionBatchWorkspace(this.wallet, begin, args, capabilities)
    return this.workspace
  }

  async plan (args: Validation.ValidCreateActionArgs): Promise<StorageCreateActionResult | undefined> {
    return await this.runExclusive(async () => {
      if (!args.isNewTx) return undefined
      let workspace = this.workspace
      let beganWorkspace = false
      if (workspace == null) {
        if (!args.isNoSend) return undefined
        workspace = await this.begin(args)
        if (workspace == null) return undefined
        beganWorkspace = true
      }
      try {
        return await workspace.plan(args)
      } catch (error) {
        if (beganWorkspace) {
          await workspace.abort()
          this.workspace = undefined
        }
        throw error
      }
    })
  }

  async process (
    prior: PendingSignAction | undefined,
    args: Validation.ValidProcessActionArgs
  ): Promise<StorageProcessActionResults | undefined> {
    return await this.runExclusive(async () => {
      const workspace = this.workspace
      if (workspace == null) return undefined
      if (prior != null && !workspace.ownsReference(prior.reference)) return undefined
      if (prior != null) workspace.stage(prior, args)
      const shouldCommit = args.isSendWith || (prior != null && !args.isNoSend)
      if (!shouldCommit) return { sendWithResults: [] }
      const sendWith = [...args.options.sendWith]
      if (prior != null && !args.isNoSend && !sendWith.includes(prior.tx.id('hex'))) sendWith.push(prior.tx.id('hex'))
      const result = await workspace.commit(sendWith, args.isDelayed)
      this.workspace = undefined
      return result
    })
  }

  ownsReference (reference: string): boolean {
    return this.workspace?.ownsReference(reference) ?? false
  }

  async abort (): Promise<boolean> {
    return await this.runExclusive(async () => {
      if (this.workspace == null) return false
      await this.workspace.abort()
      this.workspace = undefined
      return true
    })
  }

  async abortAction (referenceOrTxid: string): Promise<boolean> {
    return await this.runExclusive(async () => {
      const workspace = this.workspace
      if (workspace == null) return false
      const aborted = workspace.abortAction(referenceOrTxid)
      if (!aborted) return false
      if (workspace.isEmpty) {
        await workspace.abort()
        this.workspace = undefined
      }
      return true
    })
  }
}
