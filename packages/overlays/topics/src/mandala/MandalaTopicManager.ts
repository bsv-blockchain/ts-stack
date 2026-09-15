import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, Hash, LockingScript, Transaction, Utils, WalletInterface, WalletProtocol } from '@bsv/sdk'
import { MandalaToken, MandalaAdmin, MandalaActionDetails } from '@bsv/templates'
import { verifyKeyLinkage, verifyInputKeyLinkage } from './verifyKeyLinkage.js'
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
    /**
     * Has this topic already admitted `txid.outputIndex` as an admin-auth
     * output of `assetId`? This anchors the admin chain — see
     * {@link MandalaTopicManager.priorAnchored}. Optional so existing
     * deployments keep building; when it is absent the anchor falls back to
     * requiring the prior to be a previously admitted coin of this topic,
     * which is still strictly stronger than the old any-input check.
     */
    isAdminOutpoint?: (assetId: string, txid: string, outputIndex: number) => Promise<boolean>
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

const outpointOfInput = (inp: Transaction['inputs'][number]): string =>
  `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? ''}.${inp.sourceOutputIndex}`

const splitOutpoint = (op: string): { txid: string, vout: number } | null => {
  const dot = op.lastIndexOf('.')
  if (dot <= 0) return null
  const vout = Number(op.slice(dot + 1))
  if (!Number.isInteger(vout) || vout < 0) return null
  return { txid: op.slice(0, dot), vout }
}

export class MandalaTopicManager implements TopicManager {
  constructor (private readonly deps: MandalaTopicManagerDeps) {}

  private async classifyOutputs (
    tx: Transaction,
    payload: ReturnType<typeof decodeLinkagePayload> & { admin?: Array<{ index: number, actionDetails: MandalaActionDetails }> },
    admittedInputs: Set<string>
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
      const classified = await this.classifyOutput(tx, i, adminDetails.get(i), admittedInputs)
      if (classified.kind === 'skip') continue
      if (classified.kind === 'ft') {
        ftOutputs.push(classified.ft)
        continue
      }
      adminIndices.push(classified.index)
      if (classified.details != null && typeof classified.details.assetId === 'string') {
        verifiedAdminAssetKinds.set(classified.details.assetId, classified.details)
      }
      if (classified.issuance != null) {
        const { assetId, amount } = classified.issuance
        authorizedIssuance.set(assetId, (authorizedIssuance.get(assetId) ?? 0) + amount)
      }
    }
    return { ftOutputs, adminIndices, authorizedIssuance, verifiedAdminAssetKinds }
  }

  // Classifies a single output as an FT output, an admitted admin-auth output,
  // or a skip (neither). Split out of classifyOutputs to keep the per-output
  // branching (and its 1-satoshi guards) out of the loop body.
  private async classifyOutput (
    tx: Transaction,
    i: number,
    adminDetail: MandalaActionDetails | undefined,
    admittedInputs: Set<string>
  ): Promise<
  { kind: 'ft', ft: FtOutput } |
  { kind: 'admin', index: number, details: MandalaActionDetails | undefined, issuance?: { assetId: string, amount: number } } |
  { kind: 'skip' }
  > {
    const ls = tx.outputs[i].lockingScript
    const ft = decodeFtOutput(ls)
    if (ft != null) {
      // Token value lives in the script payload, never in the output's
      // satoshis: every token output must carry exactly 1 satoshi, so sats
      // cannot be stranded inside token outputs. Throwing here rejects the
      // whole tx (see the rejection note in identifyAdmissibleOutputs).
      this.requireOneSat(tx, i, 'token')
      return { kind: 'ft', ft: { index: i, ...ft } }
    }
    const admin = await this.verifyAdminOutput(tx, ls, adminDetail, admittedInputs)
    if (!admin.admitted) return { kind: 'skip' }
    // Same 1-satoshi rule for admin-auth outputs — enforced only AFTER
    // verifyAdminOutput admits: MandalaAdmin.decode matches any bare
    // P2PKH, so checking earlier would reject ordinary wallet change.
    this.requireOneSat(tx, i, 'admin')
    return { kind: 'admin', index: i, details: adminDetail, issuance: admin.issuance }
  }

  // Shared 1-satoshi guard for both token and admin outputs; throws with the
  // same message shape either call site previously inlined.
  private requireOneSat (tx: Transaction, i: number, label: 'token' | 'admin'): void {
    if (tx.outputs[i].satoshis !== 1) {
      throw new Error(`${label} output ${i} must carry exactly 1 satoshi`)
    }
  }

  /**
   * Is this admin action anchored to the asset's admin chain?
   *
   * Authority on the admin chain is the CHAIN OF SPENDS, not key
   * re-derivation. `details.counterparty` arrives in the unauthenticated
   * off-chain payload, and BRC-42 derivation against a counterparty yields a
   * key that counterparty can itself compute — and spend — from its own root
   * key plus this overlay's PUBLIC identity key. So re-deriving the lock key
   * proves nothing about who authored the action; a third party could
   * otherwise forge `unpause`, `unfreeze`, `allowIdentity` and, because a
   * verified admin output credits authorized issuance, `issue`/`reissue`.
   *
   * What does prove authorship is the prior: the action must SPEND the admin
   * output this topic already admitted for that asset. Delegation still works,
   * because whoever the new output is locked to holds authority next.
   *
   * `register` is exempt: its assetId is its own genesis outpoint, so it
   * confers authority over nothing that already exists.
   */
  private async priorAnchored (
    details: MandalaActionDetails,
    admittedInputs: Set<string>
  ): Promise<boolean> {
    if (details.kind === 'register') return true
    if (typeof details.priorOutpoint !== 'string' || details.priorOutpoint === '') return false
    if (!admittedInputs.has(details.priorOutpoint)) return false
    const isAdminOutpoint = this.deps.stateStore.isAdminOutpoint
    if (isAdminOutpoint == null) return true
    if (typeof details.assetId !== 'string' || details.assetId === '') return false
    const parts = splitOutpoint(details.priorOutpoint)
    if (parts == null) return false
    return await isAdminOutpoint(details.assetId, parts.txid, parts.vout)
  }

  private async verifyAdminOutput (
    tx: Transaction,
    ls: LockingScript,
    details: MandalaActionDetails | undefined,
    admittedInputs: Set<string>
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
    if (!pkhMatches || !await this.priorAnchored(details, admittedInputs)) {
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

  /**
   * Every token-shaped output must carry a linkage that verifies to the key
   * it is locked to; one that does not REJECTS the whole transaction.
   *
   * Skipping such an output instead (the previous behaviour) left a phantom
   * coin: `conservationHolds` sums only the admitted subset, so a transaction
   * could carry an extra `MandalaToken` output of any value, still have its
   * siblings admitted, still receive the overlay's admission signature and
   * still be broadcast — mined inside a transaction the overlay genuinely
   * attested to. An offline verifier that stops its coverage walk at "this
   * txid was admitted" then credits the phantom. The reason string is the
   * wire contract's (§6) and is byte-identical across engines.
   */
  private async verifyFtOutputs (
    ftOutputs: FtOutput[],
    outputLinkage: Map<number, SpecificLinkage>
  ): Promise<AdmittedFt[]> {
    const admittedFt: AdmittedFt[] = []
    for (const ft of ftOutputs) {
      const linkage = outputLinkage.get(ft.index)
      if (linkage == null) throw new Error(unlinkedTokenReason(ft.index))
      let verified: Awaited<ReturnType<typeof verifyKeyLinkage>>
      try {
        verified = await verifyKeyLinkage(linkage, this.deps.verifierWallet)
      } catch {
        // The verifier wallet is local, in-process crypto: a throw here is a
        // malformed linkage, which proves nothing about the output.
        throw new Error(unlinkedTokenReason(ft.index))
      }
      if (!sameBytes(verified.pubKeyHash, ft.pubKeyHash)) throw new Error(unlinkedTokenReason(ft.index))
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

  /**
   * Name the party spending each token input.
   *
   * An output's owner is bound once, when this topic admits it, from the
   * recipient its output linkage declares — the lookup service stores that on
   * the token row. A spend is therefore named from that stored owner, which is
   * payload-independent (a submitter cannot steer it) and unaffected by sender
   * blinding: the blinded key that PAID the coin is never an identity and is
   * never consulted.
   *
   * An input linkage, when supplied, is treated as a proof rather than as the
   * source of identity: it must reconstruct the very key that locks the coin
   * being spent (`prover + L*G`) and must agree with the stored owner. A
   * linkage failing either check rejects the whole transaction.
   */
  private async resolveSpendIdentities (
    tx: Transaction,
    previousCoins: number[],
    payload: ReturnType<typeof decodeLinkagePayload>
  ): Promise<string[]> {
    const linkByIndex = new Map<number, SpecificLinkage>()
    for (const inp of payload.inputs) linkByIndex.set(inp.index, inp.linkage)

    const seen = new Set<string>()
    for (const ci of previousCoins) {
      const spender = await this.spenderOfInput(tx, ci, linkByIndex.get(ci))
      if (spender !== undefined) seen.add(spender)
    }
    return [...seen]
  }

  /**
   * The identity spending token input `ci`, or `undefined` when the input is
   * not a token coin or has no owner on record and no linkage.
   *
   * Throws when a supplied linkage does not control the coin or names a party
   * other than the stored owner — either rejects the whole transaction.
   */
  private async spenderOfInput (
    tx: Transaction,
    ci: number,
    linkage: SpecificLinkage | undefined
  ): Promise<string | undefined> {
    const input = tx.inputs[ci]
    const src = input?.sourceTransaction?.outputs[input.sourceOutputIndex]
    if (input == null || src == null) return undefined
    const decoded = decodeFtOutput(src.lockingScript)
    if (decoded == null) return undefined

    const txid = input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? ''
    const row = await this.deps.stateStore.getTokenRow(txid, input.sourceOutputIndex)
    const stored = row?.identityKey ?? ''

    if (linkage == null) return stored === '' ? undefined : stored

    const v = await verifyInputKeyLinkage(linkage, this.deps.verifierWallet)
    if (!sameBytes(v.pubKeyHash, decoded.pubKeyHash)) {
      throw new Error(`input ${ci} linkage does not control the coin being spent`)
    }
    if (stored !== '' && stored.toLowerCase() !== v.identityKey.toLowerCase()) {
      throw new Error(`input ${ci} linkage names ${v.identityKey} but the coin is owned by ${stored}`)
    }
    return v.identityKey
  }

  private async anySanctioned (
    admittedFt: AdmittedFt[],
    spenders: string[]
  ): Promise<boolean> {
    const identityKeys = new Set<string>()
    for (const ft of admittedFt) identityKeys.add(ft.identityKey)
    for (const k of spenders) identityKeys.add(k)
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
    spenders: string[]
  ): Promise<boolean> {
    const assets = new Set<string>(admittedFt.map(f => f.assetId))
    for (const ci of tx.inputs) {
      const id = this.ftInputAssetId(ci)
      if (id != null) assets.add(id)
    }

    const inputOutpoints = tx.inputs.map(
      i => `${i.sourceTXID ?? i.sourceTransaction?.id('hex') ?? ''}.${i.sourceOutputIndex}`
    )

    // Senders were resolved once, from the owner bound when each coin was
    // admitted (see resolveSpendIdentities).
    const resolveSenders = async (): Promise<string[]> => spenders

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

      // Outpoints of inputs the engine says this topic previously admitted.
      // The admin chain is anchored to these; see priorAnchored.
      const admittedInputs = new Set<string>(
        previousCoins.filter(ci => ci < tx.inputs.length).map(ci => outpointOfInput(tx.inputs[ci]))
      )

      const { ftOutputs, adminIndices, authorizedIssuance, verifiedAdminAssetKinds } = await this.classifyOutputs(tx, payload as any, admittedInputs)

      const outputLinkage = new Map<number, SpecificLinkage>()
      for (const o of payload.outputs) outputLinkage.set(o.index, o.linkage)

      const admittedFt = await this.verifyFtOutputs(ftOutputs, outputLinkage)

      // Rejections THROW rather than return empty instructions: the engine
      // treats a thrown topic as failed and (with a broadcaster configured)
      // never broadcasts a transaction every topic rejected. Returning empty
      // here would be indistinguishable from a legitimate consume-only
      // transaction, and a rejected transfer that still reaches the network
      // desyncs the submitter's wallet (it aborts the action on rejection).
      if (!this.conservationHolds(admittedFt, previousCoins, tx, authorizedIssuance)) {
        throw new Error('conservation violated: outputs exceed authorized inputs/issuance')
      }

      // Name each spender from the owner bound when this topic admitted the
      // coin. Input linkages, when present, are proofs checked against the
      // spent key — never the source of identity.
      const spenders = await this.resolveSpendIdentities(tx, previousCoins, payload)

      if (await this.anySanctioned(admittedFt, spenders)) {
        throw new Error('sanctioned party involved in transfer')
      }

      if (!(await this.controlGate(tx, admittedFt, verifiedAdminAssetKinds, spenders))) {
        throw new Error('control gate rejected the transaction (paused asset or access mode)')
      }

      return {
        outputsToAdmit: [...admittedFt.map(f => f.index), ...adminIndices].sort((a, b) => a - b),
        coinsToRetain: previousCoins
      }
    } catch (error) {
      console.warn(`[MandalaTopicManager] identifyAdmissibleOutputs rejected: ${String(error)}`)
      throw error
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

/** Wire contract §6 — the same bytes on every engine. Do not reword. */
export const unlinkedTokenReason = (index: number): string =>
  `output ${index}: MandalaToken-decodable output with no verified linkage`

function sameBytes (a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
