import type { BTMSPromptInfo } from './types'

/**
 * Parses the BTMS token message to extract structured information.
 * Now supports JSON-encoded spend info from BasicTokenModule.
 */
export const parseTokenMessage = (message: string): BTMSPromptInfo | null => {
  try {
    const parsed = JSON.parse(message)
    if (parsed.type === 'btms_spend' || parsed.type === 'btms_burn' || parsed.type === 'btms_access') {
      return parsed as BTMSPromptInfo
    }
  } catch {
    // Not JSON, fall back to legacy parsing
  }

  // Legacy format: "Spend {amount} {tokenName} token(s)\n\nAsset ID: {assetId}\nApp: {app}"
  const lines = message.split('\n')
  const firstLine = lines[0] || ''

  const spendMatch = firstLine.match(/Spend (\d+) (.+?) token/)
  const amount = spendMatch?.[1] ? parseInt(spendMatch[1], 10) : 0
  const tokenName = spendMatch?.[2] || 'Unknown Token'

  const assetIdMatch = message.match(/Asset ID: (.+?)(?:\n|$)/)
  const assetId = assetIdMatch?.[1] || ''

  return {
    type: 'btms_spend',
    sendAmount: amount,
    tokenName,
    assetId,
    changeAmount: 0,
    totalInputAmount: amount
  }
}

/**
 * Formats a number with locale-aware separators
 */
export const formatAmount = (amount: number): string => {
  return amount.toLocaleString()
}

/**
 * Truncates a hex string (like identity key or asset ID) for display
 */
export const truncateHex = (hex: string, startChars = 8, endChars = 6): string => {
  if (hex.length <= startChars + endChars + 3) return hex
  return `${hex.slice(0, startChars)}...${hex.slice(-endChars)}`
}

export const normalizeAppLabel = (rawLabel: string): string => {
  let label = rawLabel
  if (label.startsWith('babbage_app_')) {
    label = label.substring(12)
  }
  if (label.startsWith('https://')) {
    label = label.substring(8)
  }
  if (label.startsWith('http://')) {
    label = label.substring(7)
  }
  return label
}

export const resolveAppBaseUrl = (label: string): string => {
  return label.startsWith('localhost:') ? `http://${label}` : `https://${label}`
}
