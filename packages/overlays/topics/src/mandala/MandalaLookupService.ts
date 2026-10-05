// The Mandala lookup service on BRC-162 (spec §4.2a, §6.5, §6.6). It projects
// every admitted token output into the owner index (value rows with their
// balances, authority rows, linkage records), stores each deploy's metadata,
// records and folds each committed admin action, and answers the lookup keys.
// It also carries the package eviction API: purge and refold a transaction's
// admin history, and restore a spent input's row from the owner journal.
//
// Owners come from the append-only owner journal the topic manager writes
// before admittance. Every index write here is first-write-wins, so a replayed
// notification, or a row already repaired inline by a spend, changes nothing.
import { Transaction } from '@bsv/sdk'
import { toHex } from '@bsv/sdk/primitives/utils'
import type { WalletInterface } from '@bsv/sdk'
import type {
  AdmissionMode,
  LookupFormula,
  LookupQuestion,
  LookupService,
  OutputAdmittedByTopic,
  OutputSpent,
  SpendNotificationMode
} from '@bsv/overlay'
import type { Db } from 'mongodb'
import { buildLedger, classifyAdmittedInputs, classifyOutputs } from '../brc162/ledger.js'
import type { Brc162Output } from '../brc162/ledger.js'
import {
  readInteger,
  readString,
  requireLookupQuery,
  requireTokenId,
  requireTxid
} from '../shared/queryValidation.js'
import type { LookupQueryRecord } from '../shared/queryValidation.js'
import { defaultAssetState, foldAction } from './AssetStateReducer.js'
import type { AssetAdminState, FoldContext } from './AssetStateReducer.js'
import docs from './MandalaLookupDocs.md.js'
import { MandalaStorageManager } from './MandalaStorageManager.js'
import { MANDALA_TOPIC } from './MandalaTopicManager.js'
import { ADMIN_KINDS, commitmentOf, decodeAdminDetails, deployMetadata } from './details.js'
import type { AdminDetails } from './details.js'
import { eachInOrder } from './inOrder.js'
import { txOrdering } from './ordering.js'
import { verifyOutputOwners } from './ownership.js'
import { decodeEnvelope } from './types.js'
import type { AdminHistoryEntry, MandalaEnvelope, MandalaOwnerRecord } from './types.js'

export interface MandalaLookupDeps {
  storage: MandalaStorageManager
  verifierWallet: WalletInterface
}

const LOOKUP_SERVICE = 'ls_mandala'
const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/

/** One admitted token output and the transaction it is in. */
interface Admitted {
  tx: Transaction
  txid: string
  output: Brc162Output
  outputs: Brc162Output[]
}

/** Where an action sits in fold order. */
type FoldPosition = Pick<AdminHistoryEntry, 'height' | 'offset' | 'admitSeq'>

interface Page {
  limit: number
  skip: number
}

type TokenQuery = (
  storage: MandalaStorageManager,
  tokenId: string,
  page: Page
) => Promise<LookupFormula>

// The asset state is not an output, but LookupFormula has no freeform variant, so it can only be
// returned through this cast; the overlay serves it straight from storage (spec §6.5).
const stateAnswer = (state: AssetAdminState): LookupFormula => [state] as unknown as LookupFormula

/** Token-id keys in dispatch order: the first one present answers. */
const TOKEN_QUERIES: ReadonlyArray<[string, TokenQuery]> = [
  [
    'metadataTokenId',
    async (storage, tokenId) => {
      const metadata = await storage.findMetadata(tokenId)
      return metadata === null ? [] : [{ txid: metadata.txid, outputIndex: metadata.outputIndex }]
    }
  ],
  [
    'assetStateTokenId',
    async (storage, tokenId) => stateAnswer(await storage.getAssetState(tokenId))
  ],
  [
    'adminHistoryTokenId',
    async (storage, tokenId, { limit, skip }) =>
      await storage.findAdminHistory(tokenId, limit, skip)
  ],
  [
    'authoritiesTokenId',
    async (storage, tokenId, { limit, skip }) =>
      (await storage.listAuthorities(MANDALA_TOPIC, tokenId)).slice(skip, skip + limit)
  ],
  [
    'tokenId',
    async (storage, tokenId, { limit, skip }) =>
      await storage.findTokensByTokenId(tokenId, limit, skip)
  ]
]

const QUERY_KEYS = [...TOKEN_QUERIES.map(([key]) => key), 'txid', 'outputIndex', 'limit', 'skip']

const optionalTokenId = (query: LookupQueryRecord, field: string): string | undefined =>
  query[field] === undefined ? undefined : requireTokenId(query[field], field)

function outpointOf(query: LookupQueryRecord): { txid: string; outputIndex: number } | undefined {
  const txid = requireTxid(readString(query, 'txid', { maxBytes: 64 }))
  const outputIndex =
    query.outputIndex === undefined
      ? undefined
      : readInteger(query, 'outputIndex', 0, 0, 0xffffffff)
  return txid === undefined || outputIndex === undefined ? undefined : { txid, outputIndex }
}

function admittedOutput(tx: Transaction, outputIndex: number): Admitted | undefined {
  const { outputs } = classifyOutputs(tx)
  const output = outputs.find(o => o.index === outputIndex)
  return output === undefined ? undefined : { tx, txid: tx.id('hex'), output, outputs }
}

// The journal row is the owner only when it describes this very script.
export const journalAgrees = (journal: MandalaOwnerRecord, output: Brc162Output): boolean =>
  journal.tokenId === output.tokenId &&
  journal.role === output.role &&
  Number.isSafeInteger(journal.amount) &&
  BigInt(journal.amount) === output.amount &&
  COMPRESSED_KEY.test(journal.identityKey)

/** Δ = value out − value in of the output's token over the transaction (spec §3.6). */
function deltaOf({ tx, txid, output, outputs }: Admitted): number {
  // The whole-tx payload carries no previous coins, so every token input counts.
  const inputs = classifyAdmittedInputs(tx, [...tx.inputs.keys()])
  const ledger = buildLedger(txid, outputs, inputs).get(output.tokenId)
  return ledger === undefined ? 0 : Number(ledger.valueOut - ledger.valueIn)
}

/**
 * Runs every step in order even when one fails, then rethrows the first fault: one lost write must
 * not take the writes after it down too.
 */
async function everyStep(steps: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const faults: unknown[] = []
  await eachInOrder(steps, async step => {
    try {
      await step()
    } catch (error_) {
      faults.push(error_)
    }
  })
  if (faults.length > 0) throw faults[0]
}

type Settled<T> = { ok: true; value: T } | { ok: false; fault: unknown }

const settled = async <T>(work: Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await work }
  } catch (error_) {
    return { ok: false, fault: error_ }
  }
}

const folded = (
  state: AssetAdminState,
  details: AdminDetails,
  at: FoldPosition,
  context: FoldContext
): AssetAdminState => ({
  ...foldAction(state, details, context),
  lastProcessedHeight: at.height,
  lastProcessedOffset: at.offset,
  lastAdmitSeq: at.admitSeq
})

interface Action {
  details: AdminDetails
  detailsHex: string
  commitment: string
}

/**
 * The admin action an authority output commits to, read from its envelope entry. `kinds` are the
 * kinds the topic allows (the registry topic reads its own).
 */
export function committedAction(
  output: Brc162Output,
  env: MandalaEnvelope,
  kinds: readonly string[] = ADMIN_KINDS
): Action | undefined {
  if (output.role !== 'authority') return undefined
  if (commitmentOf(output.payload, output.payloadCanonical) === undefined) return undefined
  const entry = env.admin.find(e => e.index === output.index)
  if (entry === undefined) return undefined
  const { details, commitment } = decodeAdminDetails(entry.details, kinds, output.index)
  return { details, detailsHex: entry.details, commitment: toHex(commitment) }
}

export class MandalaLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'whole-tx'
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  constructor(private readonly deps: MandalaLookupDeps) {}

  /**
   * The engine notifies each admitted output once and only logs what this throws, so a write that
   * fails here is never retried. The records nothing can rebuild come first (the committed action,
   * the deploy metadata and first state, the linkage record), and every step runs whatever an
   * earlier one did; the first fault is rethrown once all have run. The owner row and balance come
   * last: they are an index the next spend or the reconciler repairs from the owner journal.
   */
  async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'whole-tx' || payload.topic !== MANDALA_TOPIC) return
    const admitted = admittedOutput(Transaction.fromBEEF(payload.atomicBEEF), payload.outputIndex)
    if (admitted === undefined) return
    const env = decodeEnvelope(payload.offChainValues)
    await everyStep([
      async () => await this.recordAction(admitted, env),
      async () => await this.indexDeploy(admitted),
      async () => await this.indexOwner(admitted, env)
    ])
  }

  /** The journalled owner, else the owner the output's linkage proves, else none. */
  private async ownerOf(admitted: Admitted, env: MandalaEnvelope): Promise<string | undefined> {
    const { txid, output } = admitted
    const journal = await this.deps.storage.getOwnerJournal(txid, output.index, MANDALA_TOPIC)
    if (journal !== null && journalAgrees(journal, output)) return journal.identityKey
    try {
      const [linked] = await verifyOutputOwners([output], env, this.deps.verifierWallet)
      return linked.identityKey
    } catch {
      return undefined
    }
  }

  /**
   * The linkage record (it lives only in this notification's off-chain values), then the owner row
   * with its balance credit. No owner: the row is left for the reconciler.
   */
  private async indexOwner(admitted: Admitted, env: MandalaEnvelope): Promise<void> {
    const identityKey = await this.ownerOf(admitted, env)
    if (identityKey === undefined) return
    const createdAt = new Date()
    await everyStep([
      async () => await this.storeLinkage(admitted, identityKey, env, createdAt),
      async () => await this.storeOwnerRow(admitted, identityKey, createdAt)
    ])
  }

  private async storeLinkage(
    { txid, output }: Admitted,
    identityKey: string,
    env: MandalaEnvelope,
    createdAt: Date
  ): Promise<void> {
    const outputIndex = output.index
    const linkage = env.outputs.find(entry => entry.index === outputIndex)?.linkage
    if (linkage === undefined) return
    await this.deps.storage.storeLinkage({ txid, outputIndex, identityKey, linkage, createdAt })
  }

  private async storeOwnerRow(
    { txid, output }: Admitted,
    identityKey: string,
    createdAt: Date
  ): Promise<void> {
    const { storage } = this.deps
    const { index: outputIndex, tokenId } = output
    if (output.role !== 'value') {
      await storage.storeAuthorityIfAbsent({
        txid,
        outputIndex,
        topic: MANDALA_TOPIC,
        tokenId,
        identityKey,
        createdAt
      })
      return
    }
    const amount = Number(output.amount)
    const row = { txid, outputIndex, tokenId, amount, identityKey, createdAt }
    // credit on insert only, so a replay never credits twice
    if (await storage.storeTokenIfAbsent(row)) await storage.adjustBalance(identityKey, amount)
  }

  /** The decoded deploy payload, and the token's first state with its fee rate. */
  private async indexDeploy({ txid, output }: Admitted): Promise<void> {
    if (output.role !== 'deploy') return
    const { storage } = this.deps
    const metadata = deployMetadata(output.payload, output.payloadCanonical)
    await storage.storeMetadata({ tokenId: output.tokenId, txid, outputIndex: 0, ...metadata })
    await storage.putAssetStateIfAbsent(defaultAssetState(output.tokenId, metadata.feeRatePerKb))
  }

  /**
   * Appends the committed action to the history and, on that first append only, folds it. A
   * freeze's fold context is read once, here, and kept on its history row, so every later refold
   * folds exactly what the live fold did, whatever has happened to the frozen coin's row since. A
   * failed context read must not cost the action: the row is appended without it (a refold then
   * reads it live) and the fold is left to the refold.
   */
  private async recordAction(admitted: Admitted, env: MandalaEnvelope): Promise<void> {
    const action = committedAction(admitted.output, env)
    if (action === undefined) return
    const { storage } = this.deps
    const { txid, output } = admitted
    const { height, offset } = txOrdering(admitted.tx)
    const read = await settled(this.liveFoldContext(action.details, output.tokenId))
    const entry: AdminHistoryEntry = {
      tokenId: output.tokenId,
      txid,
      outputIndex: output.index,
      kind: action.details.kind,
      detailsHex: action.detailsHex,
      commitment: action.commitment,
      delta: deltaOf(admitted),
      height,
      offset,
      admitSeq: await storage.nextAdmitSeq(),
      createdAt: new Date(),
      ...(read.ok ? read.value : {})
    }
    if (!(await storage.appendAdminHistory(entry))) return
    if (!read.ok) throw read.fault
    // A crash or a store fault from here on leaves the action in the history but not in the
    // state, and no replay folds it (the append above returns false). The overlay recovers by
    // calling rebuildState for every token in tokenIdsWithHistory() at boot (a P2 duty).
    const state = await storage.getAssetState(output.tokenId)
    await storage.putAssetState(folded(state, action.details, entry, read.value))
  }

  // A freeze records the frozen row's amount and owner. The row, not the
  // journal: a coin already spent has no row, so it freezes at 0 and can never
  // be reissued as value that has moved on. A row of another token is no
  // target either: it would let a reissue of this token mint that coin's amount.
  private async liveFoldContext(details: AdminDetails, tokenId: string): Promise<FoldContext> {
    const outpoint = details.kind === 'freezeOutput' ? details.outpoint : undefined
    if (outpoint === undefined) return {}
    const [txid, vout] = outpoint.split('.')
    const row = await this.deps.storage.getTokenRow(txid, Number(vout))
    if (row?.tokenId !== tokenId) return { frozenAmount: 0, frozenOwner: '' }
    return { frozenAmount: row.amount, frozenOwner: row.identityKey }
  }

  /** The context the row was folded with; a row written before it was recorded reads it live. */
  private async recordedFoldContext(
    entry: AdminHistoryEntry,
    details: AdminDetails
  ): Promise<FoldContext> {
    if (entry.frozenAmount === undefined) return await this.liveFoldContext(details, entry.tokenId)
    return { frozenAmount: entry.frozenAmount, frozenOwner: entry.frozenOwner ?? '' }
  }

  async outputSpent(payload: OutputSpent): Promise<void> {
    if (payload.topic !== MANDALA_TOPIC) return
    await this.takeRow(payload.txid, payload.outputIndex)
  }

  async outputEvicted(txid: string, outputIndex: number): Promise<void> {
    await this.takeRow(txid, outputIndex)
    // Only the deploy at vout 0 of `txid` writes metadata, keyed `<txid>_0`.
    if (outputIndex === 0) await this.deps.storage.deleteMetadata(`${txid}_0`)
  }

  /** Removes the outpoint's value row (debiting its owner) or else its authority row. */
  private async takeRow(txid: string, outputIndex: number): Promise<void> {
    const { storage } = this.deps
    const row = await storage.takeToken(txid, outputIndex)
    if (row !== null) await storage.adjustBalance(row.identityKey, -row.amount)
    else await storage.takeAuthority(txid, outputIndex)
  }

  async lookup(question: LookupQuestion): Promise<LookupFormula> {
    const query = requireLookupQuery(question, LOOKUP_SERVICE, QUERY_KEYS)
    // Every key is validated before any is answered.
    const asked = TOKEN_QUERIES.map(([field, answer]) => ({
      tokenId: optionalTokenId(query, field),
      answer
    }))
    const outpoint = outpointOf(query)
    const page = {
      limit: readInteger(query, 'limit', 100, 1, 100),
      skip: readInteger(query, 'skip', 0, 0, 100000)
    }
    const first = asked.find(({ tokenId }) => tokenId !== undefined)
    if (first?.tokenId !== undefined) {
      return await first.answer(this.deps.storage, first.tokenId, page)
    }
    if (outpoint === undefined) throw new Error('Unsupported query')
    return await this.outpointAnswer(outpoint.txid, outpoint.outputIndex)
  }

  private async outpointAnswer(txid: string, outputIndex: number): Promise<LookupFormula> {
    const { storage } = this.deps
    const row =
      (await storage.getTokenRow(txid, outputIndex)) ??
      (await storage.getAuthorityRow(txid, outputIndex))
    return row === null ? [] : [row]
  }

  /**
   * Refolds the token's state from its history in `(height, offset, admitSeq)` order, leaving out
   * `excludeTxid`, starting from the deploy's fee rate (fees off once the deploy is gone), with each
   * freeze's recorded fold context. Run at boot for every token in `tokenIdsWithHistory()`, before
   * admissions start, it also restores an action whose fold was lost after its history row was
   * written. It reads and then writes the state, so it must never run beside a live fold.
   */
  async rebuildState(tokenId: string, excludeTxid?: string): Promise<void> {
    const { storage } = this.deps
    const metadata = await storage.findMetadata(tokenId)
    let state = defaultAssetState(tokenId, metadata?.feeRatePerKb ?? null)
    await eachInOrder(await storage.findAdminHistory(tokenId), async entry => {
      if (entry.txid === excludeTxid) return
      const { details } = decodeAdminDetails(entry.detailsHex, ADMIN_KINDS, entry.outputIndex)
      state = folded(state, details, entry, await this.recordedFoldContext(entry, details))
    })
    await storage.putAssetState(state)
  }

  /** Every token with admin history: the set the boot refold runs `rebuildState` over. */
  async tokenIdsWithHistory(): Promise<string[]> {
    return await this.deps.storage.tokenIdsWithHistory()
  }

  /**
   * Eviction (spec §6.6): refolds every token the transaction has history for without it, then
   * deletes its history rows. In that order, so an interrupted run can simply be repeated.
   * Returns the refolded token ids.
   */
  async purgeAndRefold(txid: string): Promise<string[]> {
    const { storage } = this.deps
    const tokenIds = await storage.tokensTouchedBy(txid)
    await eachInOrder(tokenIds, async tokenId => await this.rebuildState(tokenId, txid))
    await storage.deleteAdminHistoryByTxid(txid)
    return tokenIds
  }

  /**
   * Eviction restore of an input coin: its row from the journal, credited once. It does not check
   * that the coin is live: call it only after the engine confirms the input is unspent and admitted
   * again, or it restores a row (and a balance) for a coin that is gone.
   */
  async restoreInputRow(journal: MandalaOwnerRecord): Promise<boolean> {
    return (await this.deps.storage.repairOwnerRow(journal)).inserted
  }

  async getDocumentation(): Promise<string> {
    return docs
  }

  async getMetaData(): Promise<{ name: string; shortDescription: string }> {
    return {
      name: LOOKUP_SERVICE,
      shortDescription:
        'Mandala BRC-162 token index by tokenId and outpoint: metadata, admin state and history, authorities. No identity-balance query.'
    }
  }
}

export function createMandalaLookupService(
  verifierWallet: WalletInterface,
  storage?: MandalaStorageManager
): (db: Db) => MandalaLookupService {
  return (db: Db): MandalaLookupService =>
    new MandalaLookupService({
      storage: storage ?? new MandalaStorageManager(db),
      verifierWallet
    })
}
