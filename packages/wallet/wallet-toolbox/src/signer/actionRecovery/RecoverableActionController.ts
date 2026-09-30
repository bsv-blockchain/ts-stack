import { createHash } from 'node:crypto'
import { Beef, Transaction, type CreateActionArgs, type CreateActionResult, type SignActionArgs, type SignActionResult } from '@bsv/sdk'
import { validateCreateActionArgs, validateSignActionArgs, validateOriginator, type ValidCreateActionArgs, type ValidSignActionArgs } from '@bsv/sdk/wallet/validationHelpers'
import type { Wallet, PendingSignAction } from '../../Wallet'
import type { AuthId, StorageCreateActionResult } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { createAction } from '../../storage/methods/createAction'
import { actionRecoveryJSON, encodeActionRecoveryBytes } from '../../storage/actionRecovery/ActionRecoveryCodec'
import { resumeActionRecoveryPlan, validateRecoveryConstruction } from '../../storage/actionRecovery/ActionRecoveryPlan'
import { SQLiteActionRecoveryStore, type SQLiteActionRecoveryOperation, sameRecoveryLayout } from '../../storage/actionRecovery/SQLiteActionRecoveryStore'
import { buildSignableTransaction } from '../methods/buildSignableTransaction'
import { completeSignedTransaction, verifyUnlockScripts } from '../methods/completeSignedTransaction'

export type RecoveredAction =
  | { state: 'absent' }
  | { state: 'prepared'; result: CreateActionResult }
  | { state: 'finalized'; result: SignActionResult }

interface Operation {
  auth: AuthId
  args: ValidCreateActionArgs
  record: SQLiteActionRecoveryOperation
}

function requireAction(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new WERR_INVALID_OPERATION(reason)
}

/**
 * Installed local SQLite capability above ordinary BRC-100. The existing Wallet
 * methods and transport stay unchanged. All completed actions remain noSend;
 * application submission and its recovery are separate explicit operations.
 */
export class RecoverableActionController {
  constructor(private readonly wallet: Wallet, private readonly store: SQLiteActionRecoveryStore, private readonly originator: string) {
    requireAction(typeof originator === 'string', 'An explicit action recovery originator is required')
    validateOriginator(originator)
  }

  async prepare(operationId: string, request: CreateActionArgs): Promise<CreateActionResult> {
    return await this.operation(operationId, request, async operation => {
      const result = await createAction(this.store.storage, operation.auth, operation.args, undefined, operation.record)
      return await this.prepared(operation, result)
    })
  }

  async finalize(operationId: string, request: CreateActionArgs, signing: SignActionArgs): Promise<SignActionResult> {
    const signed = ownSigning(signing)
    const digest = createHash('sha256').update(actionRecoveryJSON(signed)).digest('hex')
    return await this.operation(operationId, request, async operation => {
      const retained = await operation.record.read()
      requireAction(retained?.completed !== undefined, 'Recoverable action has not finished preparation')
      requireAction(retained.completed.reference === signed.reference, 'Recoverable action reference mismatch')
      const state = await operation.record.signingState()
      requireAction(state.prepared !== undefined, 'Recoverable signable transaction is absent')
      if (state.final !== undefined) {
        requireAction(state.final.digest === digest, 'Action recovery signing request conflicts')
        return await this.process(operation, state.final.digest, state.final.beef)
      }
      const allocated = await this.store.storage.findTransactions({ partial: { userId: operation.auth.userId, reference: signed.reference }, noRawTx: true })
      requireAction(allocated.length === 1 && allocated[0].status === 'unsigned', 'Recoverable allocation is no longer available for signing')
      const prior = this.pending(operation.args, retained.completed)
      requireAction(prior.tx.toHex() === Transaction.fromAtomicBEEF(state.prepared).toHex(), 'Recovered signable transaction changed')
      for (const [index, spend] of Object.entries(signed.spends)) requireAction(spend.sequenceNumber === undefined || spend.sequenceNumber === prior.tx.inputs[Number(index)]?.sequence, 'Signing request changed funded sequence')
      const before = Transaction.fromBinary(prior.tx.toBinary())
      prior.tx = await completeSignedTransaction(prior, signed.spends, this.wallet)
      requireAction(sameRecoveryLayout(before, prior.tx), 'Final action changed funded layout')
      const beef = Beef.fromBinaryStrict(retained.completed.inputBeef!)
      beef.mergeTransaction(prior.tx)
      const checked = await verifyUnlockScripts(prior.tx.id('hex'), beef, this.wallet.scriptVerifier)
      requireAction(checked.skippedInputs === 0 && checked.verifiedInputs === prior.tx.inputs.length, 'Full input evidence is required for recoverable finalization')
      const bytes = await operation.record.retainFinal(digest, beef.toBinaryAtomic(prior.tx.id('hex')))
      return await this.process(operation, digest, bytes)
    })
  }

  /** Resume retained work only. Absence never invokes a new funding allocation. */
  async recover(operationId: string, request: CreateActionArgs): Promise<RecoveredAction> {
    return await this.operation(operationId, request, async operation => {
      const retained = await operation.record.read()
      if (retained === undefined) return { state: 'absent' }
      const result = await resumeActionRecoveryPlan(this.store.storage, operation.record, retained)
      const state = await operation.record.signingState()
      if (state.final !== undefined) return { state: 'finalized', result: await this.process(operation, state.final.digest, state.final.beef) }
      return { state: 'prepared', result: await this.prepared(operation, result) }
    })
  }

  private async operation<T>(operationId: string, request: CreateActionArgs, run: (operation: Operation) => Promise<T>): Promise<T> {
    const args = validateCreateActionArgs(request)
    validateRecoveryConstruction(args)
    // This capability always retains complete source bytes. It never inherits a
    // caller's known-txid cache or an action-batch workspace's ephemeral plan.
    args.includeAllSourceTransactions = true
    const encoded = actionRecoveryJSON({ ...args, inputBEEF: args.inputBEEF === undefined ? undefined : encodeActionRecoveryBytes(args.inputBEEF) })
    const owned = JSON.parse(encoded) as Omit<ValidCreateActionArgs, 'inputBEEF'> & { inputBEEF?: string }
    const inputBeef = owned.inputBEEF
    const snapshot: ValidCreateActionArgs = { ...owned, inputBEEF: inputBeef === undefined ? undefined : Array.from(Buffer.from(inputBeef, 'base64')) }
    return await this.wallet.storage.runAsStorageProvider(async active => {
      requireAction(active === this.store.storage, 'Action recovery storage is not the active wallet provider')
      requireAction(!this.wallet.actionBatch.hasWorkspace, 'Recoverable actions require a separate committed wallet workspace')
      const auth = await this.wallet.storage.getAuth(true)
      const record = await this.store.operation({
        userId: auth.userId!, walletIdentity: this.wallet.identityKey,
        storageIdentity: active.getSettings().storageIdentityKey, chain: this.wallet.chain,
        originator: this.originator, operationId, requestJSON: encoded
      })
      return await run({ auth, args: snapshot, record })
    })
  }

  private pending(args: ValidCreateActionArgs, dcr: StorageCreateActionResult): PendingSignAction {
    const { tx, amount, pdi } = buildSignableTransaction(dcr, args, this.wallet)
    return { reference: dcr.reference, args, dcr, tx, amount, pdi }
  }

  private async prepared(operation: Operation, result: StorageCreateActionResult): Promise<CreateActionResult> {
    const prior = this.pending(operation.args, result)
    const beef = Beef.fromBinaryStrict(result.inputBeef!)
    beef.mergeTransaction(prior.tx)
    const tx = await operation.record.retainPrepared(beef.toBinaryAtomic(prior.tx.id('hex')))
    return {
      signableTransaction: { reference: result.reference, tx },
      noSendChange: result.noSendChangeOutputVouts?.map(index => `${prior.tx.id('hex')}.${index}`)
    }
  }

  private async process(operation: Operation, digest: string, bytes: number[]): Promise<SignActionResult> {
    const tx = Transaction.fromAtomicBEEF(bytes)
    const retained = await operation.record.read()
    requireAction(retained?.completed !== undefined, 'Action recovery funding result is absent')
    const state = await operation.record.signingState()
    requireAction(state.prepared !== undefined && sameRecoveryLayout(Transaction.fromAtomicBEEF(state.prepared), tx), 'Retained final action changed funded layout')
    const checked = await verifyUnlockScripts(tx.id('hex'), Beef.fromBinaryStrict(bytes), this.wallet.scriptVerifier)
    requireAction(checked.skippedInputs === 0 && checked.verifiedInputs === tx.inputs.length, 'Retained final action lacks complete valid inputs')
    const reference = retained.completed.reference
    if (!(await this.processed(operation.auth, reference, tx))) {
      try {
        await this.store.storage.processAction(operation.auth, {
          reference, txid: tx.id('hex'), rawTx: tx.toBinary(),
          isNewTx: true, isSendWith: false, isNoSend: true, isDelayed: false, sendWith: []
        })
      } catch (error) {
        // A committed response can be lost. Only exact durable transaction
        // evidence establishes completion; absence is never presumed success.
        if (!(await this.processed(operation.auth, reference, tx))) throw error
      }
      requireAction(await this.processed(operation.auth, reference, tx), 'Action processing has not committed')
    }
    await operation.record.markProcessed(digest)
    return { txid: tx.id('hex'), tx: [...bytes] }
  }

  private async processed(auth: AuthId, reference: string, expected: Transaction): Promise<boolean> {
    const rows = await this.store.storage.findTransactions({ partial: { userId: auth.userId, reference } })
    requireAction(rows.length === 1, 'Action recovery wallet transaction is absent')
    const row = rows[0]
    if (row.status === 'unsigned' && row.txid == null) return false
    requireAction(row.txid === expected.id('hex') && ['nosend', 'unprocessed', 'sending', 'unproven', 'completed'].includes(row.status), 'Action recovery wallet transaction conflicts')
    const evidence = await this.store.storage.getProvenOrRawTx(expected.id('hex'))
    const raw = evidence.rawTx ?? evidence.proven?.rawTx
    requireAction(raw != null && Buffer.from(raw).toString('hex') === expected.toHex(), 'Exact processed action bytes are unavailable')
    return true
  }
}

function ownSigning(signing: SignActionArgs): ValidSignActionArgs {
  requireAction(signing.options?.noSend !== false && signing.options?.returnTXIDOnly !== true && (signing.options?.sendWith?.length ?? 0) === 0, 'Recoverable finalization must remain full-evidence noSend')
  const value = validateSignActionArgs({ ...signing, options: { ...signing.options, noSend: true, returnTXIDOnly: false, sendWith: [] } })
  return JSON.parse(actionRecoveryJSON(value)) as ValidSignActionArgs
}
