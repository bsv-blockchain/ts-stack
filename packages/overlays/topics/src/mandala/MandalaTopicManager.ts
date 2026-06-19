import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, Transaction, WalletInterface, WalletProtocol } from '@bsv/sdk'
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

export class MandalaTopicManager implements TopicManager {
  constructor (private readonly deps: MandalaTopicManagerDeps) {}

  async identifyAdmissibleOutputs (
    beef: number[],
    previousCoins: number[],
    offChainValues?: number[]
  ): Promise<AdmittanceInstructions> {
    try {
      // Step 1: Parse transaction from BEEF
      const tx = Transaction.fromBEEF(beef)

      // Step 2: Parse linkage payload
      const payload = offChainValues != null
        ? decodeLinkagePayload(offChainValues)
        : { inputs: [], outputs: [] }

      // Step 3: Classify outputs into FT outputs and admin outputs
      const ftOutputs: Array<{ index: number, assetId: string, amount: number, pubKeyHash: number[] }> = []
      let hasVerifiedAdmin = false
      const adminIndices: number[] = []
      const adminDetails = new Map<number, MandalaActionDetails>()
      for (const a of (payload as any).admin ?? []) adminDetails.set(a.index, a.actionDetails)
      for (let i = 0; i < tx.outputs.length; i++) {
        const ls = tx.outputs[i].lockingScript
        try {
          const d = MandalaToken.decode(ls)
          ftOutputs.push({ index: i, ...d })
          continue
        } catch { /* not FT */ }
        try {
          const decodedAdmin = MandalaAdmin.decode(ls)
          const details = adminDetails.get(i)
          if (details != null) {
            const adminTemplate = new MandalaAdmin(this.deps.adminWallet)
            const { boundKey } = await adminTemplate.deriveBoundKey(this.deps.adminProtocolID, details)
            const priorOk = details.kind === 'register' ||
              (typeof details.priorOutpoint === 'string' &&
                tx.inputs.some(inp => `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? ''}.${inp.sourceOutputIndex}` === details.priorOutpoint))
            if (boundKey === decodedAdmin.boundKey && priorOk) {
              adminIndices.push(i)
              hasVerifiedAdmin = true
            }
          }
        } catch { /* not admin */ }
      }

      // Build output linkage map
      const outputLinkage = new Map<number, SpecificLinkage>()
      for (const o of payload.outputs) outputLinkage.set(o.index, o.linkage)

      // Step 4: Verify linkage per FT output
      const admittedFt: Array<{ index: number, assetId: string, amount: number, identityKey: string }> = []
      for (const ft of ftOutputs) {
        const linkage = outputLinkage.get(ft.index)
        if (linkage == null) continue
        const verified = await verifyKeyLinkage(linkage, this.deps.verifierWallet)
        const matches = verified.pubKeyHash.length === ft.pubKeyHash.length &&
          verified.pubKeyHash.every((b, i) => b === ft.pubKeyHash[i])
        if (!matches) continue
        admittedFt.push({ index: ft.index, assetId: ft.assetId, amount: ft.amount, identityKey: verified.identityKey })
      }

      // Step 5: Conservation per assetId
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
        if (!hasVerifiedAdmin && outAmt !== inAmt) {
          return { outputsToAdmit: [], coinsToRetain: [] }
        }
      }

      // Step 6: Screen both sides
      const identityKeys = new Set<string>()
      for (const ft of admittedFt) identityKeys.add(ft.identityKey)
      for (const inp of payload.inputs) {
        const v = await verifyKeyLinkage(inp.linkage, this.deps.verifierWallet)
        identityKeys.add(v.identityKey)
      }
      for (const key of identityKeys) {
        if (await this.deps.screeningProvider.isSanctioned(key)) {
          return { outputsToAdmit: [], coinsToRetain: [] }
        }
      }

      // Step 7: Return admittance instructions
      return {
        outputsToAdmit: [...admittedFt.map(f => f.index), ...adminIndices].sort((a, b) => a - b),
        coinsToRetain: previousCoins
      }
    } catch (error) {
      // Step 8: Wrap in try/catch, warn and return empty on error
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
