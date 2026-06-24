import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, LockingScript, Transaction, WalletInterface, WalletProtocol } from '@bsv/sdk'
import { MandalaToken, MandalaAdmin, MandalaActionDetails } from '@bsv/templates'
import { verifyKeyLinkage } from './verifyKeyLinkage.js'
import { decodeLinkagePayload, ScreeningProvider, SpecificLinkage } from './types.js'
import docs from './MandalaTopicDocs.md.js'

export interface MandalaTopicManagerDeps {
  verifierWallet: WalletInterface
  screeningProvider: ScreeningProvider
  adminWallet: WalletInterface
  adminProtocolID: WalletProtocol
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
  ): Promise<{ ftOutputs: FtOutput[], adminIndices: number[], authorizedIssuance: Map<string, number> }> {
    const ftOutputs: FtOutput[] = []
    const authorizedIssuance = new Map<string, number>()
    const adminIndices: number[] = []
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
      if (admin.issuance != null) {
        const { assetId, amount } = admin.issuance
        authorizedIssuance.set(assetId, (authorizedIssuance.get(assetId) ?? 0) + amount)
      }
    }
    return { ftOutputs, adminIndices, authorizedIssuance }
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
    const { boundKey } = await new MandalaAdmin(this.deps.adminWallet)
      .deriveBoundKey(this.deps.adminProtocolID, details)
    if (boundKey !== decodedAdmin.boundKey || !priorOutpointSpent(tx, details)) {
      return { admitted: false }
    }
    if ((details.kind === 'issue' || details.kind === 'recover') && typeof details.assetId === 'string') {
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

  async identifyAdmissibleOutputs (
    beef: number[],
    previousCoins: number[],
    offChainValues?: number[]
  ): Promise<AdmittanceInstructions> {
    try {
      const tx = Transaction.fromBEEF(beef)

      const payload = offChainValues == null ? { inputs: [], outputs: [] } : decodeLinkagePayload(offChainValues)

      const { ftOutputs, adminIndices, authorizedIssuance } = await this.classifyOutputs(tx, payload as any)

      const outputLinkage = new Map<number, SpecificLinkage>()
      for (const o of payload.outputs) outputLinkage.set(o.index, o.linkage)

      const admittedFt = await this.verifyFtOutputs(ftOutputs, outputLinkage)

      if (!this.conservationHolds(admittedFt, previousCoins, tx, authorizedIssuance)) {
        return { outputsToAdmit: [], coinsToRetain: [] }
      }

      if (await this.anySanctioned(admittedFt, payload)) {
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
