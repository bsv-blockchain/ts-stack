import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, Hash, LockingScript, Transaction, Utils, WalletInterface, WalletProtocol } from '@bsv/sdk'
import { MandalaToken, MandalaAdmin, MandalaActionDetails } from '@bsv/templates'
import { verifyKeyLinkage } from './verifyKeyLinkage.js'
import { decodeLinkagePayload, ScreeningProvider, SpecificLinkage, MandalaTokenRecord } from './types.js'
import { AssetAdminState } from './AssetStateReducer.js'
import docs from './MandalaTopicDocs.md.js'

export interface MandalaTopicManagerDeps {
  verifierWallet: WalletInterface
  screeningProvider: ScreeningProvider
  adminWallet: WalletInterface
  adminProtocolID: WalletProtocol
  stateStore: {
    getAssetState: (assetId: string) => Promise<AssetAdminState>
    getTokenRow: (txid: string, outputIndex: number) => Promise<MandalaTokenRecord | null>
  }
}

interface FtOutput { index: number, assetId: string, amount: number, pubKeyHash: number[] }
interface AdmittedFt { index: number, assetId: string, amount: number, identityKey: string }

const decodeFtOutput = (ls: LockingScript): { assetId: string, amount: number, pubKeyHash: number[] } | null => {
  try {
    return MandalaToken.decode(ls)
  } catch {
    return null
  }
}

const priorOutpointSpent = (tx: Transaction, details: MandalaActionDetails): boolean => {
  if (details.kind === 'register') return true
  if (typeof details.priorOutpoint !== 'string') return false
  return tx.inputs.some(
    inp => `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? ''}.${inp.sourceOutputIndex}` === details.priorOutpoint
  )
}

export class MandalaTopicManager implements TopicManager {
  constructor (private readonly deps: MandalaTopicManagerDeps) {}

  private async classifyOutputs (
    tx: Transaction,
    payload: ReturnType<typeof decodeLinkagePayload> & { admin?: Array<{ index: number, actionDetails: MandalaActionDetails }> }
  ): Promise<{ ftOutputs: FtOutput[], adminIndices: number[], authorizedIssuance: Map<string, number>, verifiedAdminAssetKinds: Map<string, MandalaActionDetails> }> {
    const ftOutputs: FtOutput[] = []
    const authorizedIssuance = new Map<string, number>()
    const adminIndices: number[] = []
    // assetId -> actionDetails, populated ONLY from outputs that passed
    // verifyAdminOutput (pkh + priorOutpoint). This — not the raw off-chain
    // payload.admin[] — is the source of the control-gate admin exemption, so a
    // forged admin entry over an FT output cannot bypass the pause/access gates.
    const verifiedAdminAssetKinds = new Map<string, MandalaActionDetails>()
    const adminDetails = new Map<number, MandalaActionDetails>()
    for (const a of (payload as any).admin ?? []) adminDetails.set(a.index, a.actionDetails)
    for (let i = 0; i < tx.outputs.length; i++) {
      const ls = tx.outputs[i].lockingScript
      const ft = decodeFtOutput(ls)
      if (ft != null) {
        ftOutputs.push({ index: i, ...ft })
        continue
      }
      const admin = await this.verifyAdminOutput(tx, ls, adminDetails.get(i))
      if (!admin.admitted) continue
      adminIndices.push(i)
      const details = adminDetails.get(i)
      if (details != null && typeof details.assetId === 'string') verifiedAdminAssetKinds.set(details.assetId, details)
      if (admin.issuance != null) {
        const { assetId, amount } = admin.issuance
        authorizedIssuance.set(assetId, (authorizedIssuance.get(assetId) ?? 0) + amount)
      }
    }
    return { ftOutputs, adminIndices, authorizedIssuance, verifiedAdminAssetKinds }
  }

  private async verifyAdminOutput (
    tx: Transaction,
    ls: LockingScript,
    details: MandalaActionDetails | undefined
  ): Promise<{ admitted: boolean, issuance?: { assetId: string, amount: number } }> {
    let decodedAdmin
    try {
      decodedAdmin = MandalaAdmin.decode(ls)
    } catch {
      return { admitted: false }
    }
    if (details == null) return { admitted: false }
    // The admin output is a P2PKH; re-derive the locking key with the admin wallet
    // and compare its hash160 to the on-chain pubKeyHash. counterparty defaults to
    // 'self' (self-locked auth); a transferred auth carries the grantee in details.
    const counterparty = typeof details.counterparty === 'string' ? details.counterparty : 'self'
    const { publicKey } = await this.deps.adminWallet.getPublicKey({
      protocolID: this.deps.adminProtocolID,
      keyID: MandalaAdmin.commitment(details),
      counterparty
    })
    const expected = Hash.hash160(Utils.toArray(publicKey, 'hex'))
    const pkhMatches = expected.length === decodedAdmin.pubKeyHash.length &&
      expected.every((b, i) => b === decodedAdmin.pubKeyHash[i])
    if (!pkhMatches || !priorOutpointSpent(tx, details)) {
      return { admitted: false }
    }
    if ((details.kind === 'issue' || details.kind === 'reissue') && typeof details.assetId === 'string') {
      return { admitted: true, issuance: { assetId: details.assetId, amount: details.amount ?? 0 } }
    }
    // A redeem authorizes destruction of `amount` units, i.e. a negative supply
    // delta. Without this, conservation (outAmt === inAmt + issued) rejects any
    // partial redeem, since the burned FT inputs are counted in inAmt but the
    // only output is the change (gathered - amount). Crediting -amount here makes
    // outAmt === gathered + (-amount) hold for partial burns.
    if (details.kind === 'redeem' && typeof details.assetId === 'string') {
      return { admitted: true, issuance: { assetId: details.assetId, amount: -(details.amount ?? 0) } }
    }
    return { admitted: true }
  }

  private async verifyFtOutputs (
    ftOutputs: FtOutput[],
    outputLinkage: Map<number, SpecificLinkage>
  ): Promise<AdmittedFt[]> {
    const admittedFt: AdmittedFt[] = []
    for (const ft of ftOutputs) {
      const linkage = outputLinkage.get(ft.index)
      if (linkage == null) continue
      const verified = await verifyKeyLinkage(linkage, this.deps.verifierWallet)
      const matches = verified.pubKeyHash.length === ft.pubKeyHash.length &&
        verified.pubKeyHash.every((b, i) => b === ft.pubKeyHash[i])
      if (!matches) continue
      admittedFt.push({ index: ft.index, assetId: ft.assetId, amount: ft.amount, identityKey: verified.identityKey })
    }
    return admittedFt
  }

  private conservationHolds (
    admittedFt: AdmittedFt[],
    previousCoins: number[],
    tx: Transaction,
    authorizedIssuance: Map<string, number>
  ): boolean {
    const outTotals = new Map<string, number>()
    for (const ft of admittedFt) outTotals.set(ft.assetId, (outTotals.get(ft.assetId) ?? 0) + ft.amount)

    const inTotals = new Map<string, number>()
    for (const ci of previousCoins) {
      const input = tx.inputs[ci]
      const src = input?.sourceTransaction?.outputs[input.sourceOutputIndex]
      if (src == null) continue
      try {
        const d = MandalaToken.decode(src.lockingScript)
        inTotals.set(d.assetId, (inTotals.get(d.assetId) ?? 0) + d.amount)
      } catch { /* non-token previous coin */ }
    }
    for (const [assetId, outAmt] of outTotals) {
      const inAmt = inTotals.get(assetId) ?? 0
      const issued = authorizedIssuance.get(assetId) ?? 0
      if (outAmt !== inAmt + issued) return false
    }
    return true
  }

  private async anySanctioned (
    admittedFt: AdmittedFt[],
    payload: ReturnType<typeof decodeLinkagePayload>
  ): Promise<boolean> {
    const identityKeys = new Set<string>()
    for (const ft of admittedFt) identityKeys.add(ft.identityKey)
    for (const inp of payload.inputs) {
      const v = await verifyKeyLinkage(inp.linkage, this.deps.verifierWallet)
      identityKeys.add(v.identityKey)
    }
    for (const key of identityKeys) {
      if (await this.deps.screeningProvider.isSanctioned(key)) return true
    }
    return false
  }

  // Per-asset control gate. A tx is an "issuer admin action for asset X" iff it
  // carries a verified admin output whose actionDetails.assetId === X (collected
  // into adminAssetKinds); otherwise its movement of X is a "peer transfer".
  // Sanctions screening stays separate (anySanctioned) and universal — the gates
  // here are: (1) frozen/evicted input spend (ALL txs); (2) pause and (3) access
  // mode (peer transfers only, admin actions exempt); plus the reissue guards.
  // Returns false to reject the whole tx.
  private ftInputAssetId (i: { sourceTransaction?: Transaction, sourceOutputIndex: number }): string | null {
    const src = i.sourceTransaction?.outputs[i.sourceOutputIndex]
    if (src == null) return null
    try {
      return MandalaToken.decode(src.lockingScript).assetId
    } catch {
      return null
    }
  }

  // Gate 3 (access mode) rejection test — peer transfers only. Denylist rejects if
  // any party is blocked; allowlist rejects if any party is not allowed.
  private accessModeRejects (state: AssetAdminState, parties: string[]): boolean {
    return state.accessMode === 'denylist'
      ? parties.some(k => state.blockedIdentities.includes(k))
      : parties.some(k => !state.allowedIdentities.includes(k))
  }

  // reissue guards: target outpoint must be frozen (a), the minted amount must
  // match the frozen row (b), and the tx must carry zero FT inputs of asset X (c).
  private reissueGuardFails (
    state: AssetAdminState,
    tx: Transaction,
    assetId: string,
    adminAction: MandalaActionDetails
  ): boolean {
    const op = typeof adminAction.outpoint === 'string' ? adminAction.outpoint : ''
    const ref = state.frozenOutpoints.find(f => f.outpoint === op)
    if (ref == null) return true // (a)
    if (ref.amount !== adminAction.amount) return true // (b)
    if (tx.inputs.some(i => this.ftInputAssetId(i) === assetId)) return true // (c)
    return false
  }

  private async assetGatePasses (
    assetId: string,
    tx: Transaction,
    admittedFt: AdmittedFt[],
    adminAssetKinds: Map<string, MandalaActionDetails>,
    inputOutpoints: string[],
    resolveSenders: () => Promise<string[]>
  ): Promise<boolean> {
    const state = await this.deps.stateStore.getAssetState(assetId)
    const frozen = new Set<string>([...state.frozenOutpoints.map(f => f.outpoint), ...state.evictedOutpoints])

    // Gate 1: frozen/evicted input spend — applies to ALL txs (blocks
    // redeem of a frozen coin too; only unfreeze/reissue resolve it).
    if (inputOutpoints.some(op => frozen.has(op))) return false

    const adminAction = adminAssetKinds.get(assetId)
    const isAdmin = adminAction != null

    // Gate 2: paused — peer transfers only; admin actions on X remain admitted.
    if (state.isPaused && !isAdmin) return false

    // Gate 3: access mode — peer transfers only, admin actions exempt.
    if (!isAdmin) {
      const recipients = admittedFt.filter(f => f.assetId === assetId).map(f => f.identityKey)
      const parties = [...recipients, ...await resolveSenders()].filter(k => k !== state.issuerIdentityKey)
      if (this.accessModeRejects(state, parties)) return false
    }

    if (adminAction?.kind === 'reissue' && this.reissueGuardFails(state, tx, assetId, adminAction)) return false

    return true
  }

  private async controlGate (
    tx: Transaction,
    admittedFt: AdmittedFt[],
    adminAssetKinds: Map<string, MandalaActionDetails>,
    payload: ReturnType<typeof decodeLinkagePayload>
  ): Promise<boolean> {
    const assets = new Set<string>(admittedFt.map(f => f.assetId))
    for (const ci of tx.inputs) {
      const id = this.ftInputAssetId(ci)
      if (id != null) assets.add(id)
    }

    const inputOutpoints = tx.inputs.map(
      i => `${i.sourceTXID ?? i.sourceTransaction?.id('hex') ?? ''}.${i.sourceOutputIndex}`
    )

    // Senders are derived once (shared across assets) from the input linkages.
    let senders: string[] | null = null
    const resolveSenders = async (): Promise<string[]> => {
      if (senders != null) return senders
      const out: string[] = []
      for (const inp of payload.inputs) {
        try {
          out.push((await verifyKeyLinkage(inp.linkage, this.deps.verifierWallet)).identityKey)
        } catch { /* unverifiable input linkage — not counted as a party */ }
      }
      senders = out
      return out
    }

    for (const assetId of assets) {
      if (!(await this.assetGatePasses(assetId, tx, admittedFt, adminAssetKinds, inputOutpoints, resolveSenders))) {
        return false
      }
    }
    return true
  }

  async identifyAdmissibleOutputs (
    beef: number[],
    previousCoins: number[],
    offChainValues?: number[]
  ): Promise<AdmittanceInstructions> {
    try {
      const tx = Transaction.fromBEEF(beef)

      const payload = offChainValues == null ? { inputs: [], outputs: [] } : decodeLinkagePayload(offChainValues)

      const { ftOutputs, adminIndices, authorizedIssuance, verifiedAdminAssetKinds } = await this.classifyOutputs(tx, payload as any)

      const outputLinkage = new Map<number, SpecificLinkage>()
      for (const o of payload.outputs) outputLinkage.set(o.index, o.linkage)

      const admittedFt = await this.verifyFtOutputs(ftOutputs, outputLinkage)

      if (!this.conservationHolds(admittedFt, previousCoins, tx, authorizedIssuance)) {
        return { outputsToAdmit: [], coinsToRetain: [] }
      }

      if (await this.anySanctioned(admittedFt, payload)) {
        return { outputsToAdmit: [], coinsToRetain: [] }
      }

      if (!(await this.controlGate(tx, admittedFt, verifiedAdminAssetKinds, payload))) {
        return { outputsToAdmit: [], coinsToRetain: [] }
      }

      return {
        outputsToAdmit: [...admittedFt.map(f => f.index), ...adminIndices].sort((a, b) => a - b),
        coinsToRetain: previousCoins
      }
    } catch (error) {
      console.warn(`[MandalaTopicManager] identifyAdmissibleOutputs failed: ${String(error)}`)
      return { outputsToAdmit: [], coinsToRetain: [] }
    }
  }

  async getDocumentation (): Promise<string> {
    return docs
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return {
      name: 'tm_mandala',
      shortDescription: 'BRC-92 Mandala regulated fungible-token transfers with key-linkage verification and sanctions screening.'
    }
  }
}
