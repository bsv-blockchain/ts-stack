import {
  LookupService, LookupQuestion, LookupFormula,
  AdmissionMode, SpendNotificationMode, OutputAdmittedByTopic, OutputSpent
} from '@bsv/overlay'
import { WalletInterface, Transaction, LockingScript } from '@bsv/sdk'
import { Db } from 'mongodb'
import { MandalaToken, MandalaAdmin } from '@bsv/templates'
import { MandalaStorageManager } from './MandalaStorageManager.js'
import { verifyKeyLinkage } from './verifyKeyLinkage.js'
import { decodeLinkagePayload } from './types.js'
import { foldAction, defaultAssetState, AssetAdminState, FoldContext } from './AssetStateReducer.js'
import { txOrdering } from './ordering.js'
import docs from './MandalaLookupDocs.md.js'

export interface MandalaLookupDeps {
  storage: MandalaStorageManager
  verifierWallet: WalletInterface
}

export class MandalaLookupService implements LookupService {
  readonly admissionMode: AdmissionMode = 'whole-tx'
  readonly spendNotificationMode: SpendNotificationMode = 'script'

  constructor (private readonly deps: MandalaLookupDeps) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'whole-tx') return
    if (payload.topic !== 'tm_mandala') return
    const tx = Transaction.fromBEEF(payload.atomicBEEF)
    const txid = tx.id('hex')
    const ls = tx.outputs[payload.outputIndex].lockingScript
    let decoded
    try {
      decoded = MandalaToken.decode(ls)
    } catch {
      // Not an FT. It may be an admin output: index its publicData as metadata
      // (register) and/or fold its action into the asset's admin state + history.
      await this.indexAdminOutput(tx, txid, payload.outputIndex, ls, payload.offChainValues)
      return
    }
    // Resolve controlling identity from the matching off-chain linkage.
    let identityKey = ''
    let matchedLinkage = null
    if (payload.offChainValues != null) {
      const parsed = decodeLinkagePayload(payload.offChainValues)
      const match = parsed.outputs.find(o => o.index === payload.outputIndex)
      if (match != null) {
        const v = await verifyKeyLinkage(match.linkage, this.deps.verifierWallet)
        identityKey = v.identityKey
        matchedLinkage = match.linkage
      }
    }
    const now = new Date()
    await this.deps.storage.storeToken({
      txid,
      outputIndex: payload.outputIndex,
      assetId: decoded.assetId,
      amount: decoded.amount,
      identityKey,
      createdAt: now
    })
    if (identityKey !== '') {
      await this.deps.storage.adjustBalance(identityKey, decoded.amount)
      if (matchedLinkage != null) {
        await this.deps.storage.storeLinkage({
          txid,
          outputIndex: payload.outputIndex,
          identityKey,
          linkage: matchedLinkage,
          createdAt: now
        })
      }
    }
  }

  private async indexAdminOutput (
    tx: Transaction,
    txid: string,
    outputIndex: number,
    ls: LockingScript,
    offChainValues?: number[]
  ): Promise<void> {
    let admin
    try {
      admin = MandalaAdmin.decode(ls)
    } catch {
      return // not a mandala admin output
    }
    // Existing metadata behaviour: register's publicData is anchored on-chain and
    // served by its own outpoint (= assetId).
    if (admin.publicData != null) {
      await this.deps.storage.storeMetadata({
        txid,
        outputIndex,
        assetId: `${txid}.${outputIndex}`
      })
    }
    // Fold the action into AssetAdminState + record ordered history.
    const parsed = offChainValues != null
      ? decodeLinkagePayload(offChainValues)
      : { inputs: [], outputs: [], admin: [] as any[] }
    const entry = (parsed.admin ?? []).find((a) => a.index === outputIndex)
    if (entry == null) return
    const details = entry.actionDetails
    const assetId = typeof details.assetId === 'string' && details.assetId !== '' ? details.assetId : `${txid}.${outputIndex}`
    const { height, offset } = txOrdering(tx)
    const admitSeq = await this.deps.storage.nextAdmitSeq()
    await this.deps.storage.appendAdminHistory({
      assetId, txid, outputIndex, height, offset, admitSeq, actionDetails: details, createdAt: new Date()
    })
    const ctx: FoldContext = {}
    // Source the issuer from the persisted actionDetails (same as rebuildState),
    // not from publicData, so a live admit and a later rebuild agree. Only
    // actionDetails is persisted in AdminHistoryEntry; publicData is not.
    if (details.kind === 'register' && typeof details.issuer === 'string') {
      ctx.issuer = details.issuer
    }
    if (details.kind === 'freezeOutput' && typeof details.outpoint === 'string') {
      const [ftxid, fvoutStr] = details.outpoint.split('.')
      const row = await this.deps.storage.getTokenRow(ftxid, Number(fvoutStr))
      if (row != null) { ctx.frozenAmount = row.amount; ctx.frozenOwner = row.identityKey }
    }
    const prev = await this.deps.storage.getAssetState(assetId)
    const next = foldAction(prev, details, ctx)
    next.lastProcessedHeight = height
    next.lastProcessedOffset = offset
    next.lastAdmitSeq = admitSeq
    await this.deps.storage.putAssetState(next)
  }

  async rebuildState (assetId: string): Promise<AssetAdminState> {
    const history = await this.deps.storage.findAdminHistoryByAssetId(assetId)
    let state = defaultAssetState(assetId)
    for (const e of history) {
      const ctx: FoldContext = {}
      if (e.actionDetails.kind === 'freezeOutput' && typeof e.actionDetails.outpoint === 'string') {
        const [ft, fv] = e.actionDetails.outpoint.split('.')
        const row = await this.deps.storage.getTokenRow(ft, Number(fv))
        if (row != null) { ctx.frozenAmount = row.amount; ctx.frozenOwner = row.identityKey }
      }
      if (e.actionDetails.kind === 'register' && typeof (e.actionDetails as any).issuer === 'string') {
        ctx.issuer = (e.actionDetails as any).issuer
      }
      state = foldAction(state, e.actionDetails, ctx)
    }
    await this.deps.storage.putAssetState(state)
    return state
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== 'tm_mandala') return
    const rows = await this.deps.storage.findByOutpoint(payload.txid, payload.outputIndex)
    if (rows.length > 0) {
      const tokenRow = await this.deps.storage.getTokenRow(payload.txid, payload.outputIndex)
      if (tokenRow != null && tokenRow.identityKey !== '') {
        await this.deps.storage.adjustBalance(tokenRow.identityKey, -tokenRow.amount)
      }
    }
    await this.deps.storage.deleteToken(payload.txid, payload.outputIndex)
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.deps.storage.deleteToken(txid, outputIndex)
    await this.deps.storage.deleteMetadata(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    const query = (question as any).query ?? {}
    if (typeof query.metadataAssetId === 'string') {
      return await this.deps.storage.findMetadataByAssetId(query.metadataAssetId)
    }
    if (typeof query.assetStateAssetId === 'string') {
      // LookupFormula is strictly Array<{ txid, outputIndex, ... }> with no freeform
      // object variant, so admin-state/history rows can only be returned through this
      // double cast. It is load-bearing for the build; the disable keeps
      // `ts-standard --fix` from stripping it under a strictNullChecks-on config (which
      // would break the build in Task 7 / CI).
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return await this.deps.storage.findStateByAssetId(query.assetStateAssetId) as unknown as LookupFormula
    }
    if (typeof query.adminHistoryAssetId === 'string') {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return await this.deps.storage.findAdminHistoryByAssetId(query.adminHistoryAssetId) as unknown as LookupFormula
    }
    if (typeof query.assetId === 'string') {
      return await this.deps.storage.findByAssetId(query.assetId)
    }
    if (typeof query.txid === 'string' && typeof query.outputIndex === 'number') {
      return await this.deps.storage.findByOutpoint(query.txid, query.outputIndex)
    }
    throw new Error('Unsupported query')
  }

  async getDocumentation (): Promise<string> {
    return docs
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return {
      name: 'ls_mandala',
      shortDescription: 'Mandala token index by assetId/outpoint. No public identity-balance query.'
    }
  }
}

export function createMandalaLookupService (verifierWallet: WalletInterface, storage?: MandalaStorageManager) {
  return (db: Db): MandalaLookupService => new MandalaLookupService({
    storage: storage ?? new MandalaStorageManager(db),
    verifierWallet
  })
}
