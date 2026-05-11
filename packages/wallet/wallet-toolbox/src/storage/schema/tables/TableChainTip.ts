import * as sdk from '../../../sdk'

/**
 * V7 singleton row tracking the most recently observed chain tip.
 * Used by spendability checks and coinbase maturity calculations.
 */
export interface TableChainTip extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  /** Always 1 — singleton enforced by storage layer */
  id: number
  height: number
  blockHash: string
  merkleRoot?: string
  /** Wall-clock of the observation */
  observedAt: Date
}
