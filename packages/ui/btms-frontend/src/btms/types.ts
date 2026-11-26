import type { BTMSAsset } from '@bsv/btms'

export interface AssetView extends BTMSAsset {
  iconURL?: string
  description?: string
  incoming?: boolean
  incomingAmount?: number
  hasPendingIncoming?: boolean
}

export const toAssetView = (asset: BTMSAsset): AssetView => ({
  ...asset,
  iconURL: asset.metadata?.iconURL,
  description: asset.metadata?.description
})
