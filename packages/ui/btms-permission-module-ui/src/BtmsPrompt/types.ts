import type { PaletteMode } from '@mui/material'

export interface BtmsPromptDialogProps {
  app: string
  message: string
  onAllow: () => void
  onDeny: () => void
  paletteMode?: PaletteMode
}

export interface BTMSSpendInfo {
  type: 'btms_spend'
  sendAmount: number
  tokenName: string
  assetId: string
  recipient?: string
  iconURL?: string
  changeAmount: number
  totalInputAmount: number
}

export interface BTMSBurnInfo {
  type: 'btms_burn'
  burnAmount: number
  tokenName: string
  assetId: string
  iconURL?: string
  burnAll?: boolean
}

export interface BTMSAccessInfo {
  type: 'btms_access'
  action: string
  assetId?: string
}

export type BTMSPromptInfo = BTMSSpendInfo | BTMSBurnInfo | BTMSAccessInfo
