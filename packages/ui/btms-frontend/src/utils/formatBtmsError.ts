export const formatBtmsError = (error: unknown, fallback: string = 'Something went wrong!'): string => {
  const rawMessage = error instanceof Error ? error.message : String(error || '')
  if (!rawMessage) return fallback

  const lower = rawMessage.toLowerCase()
  if (rawMessage.includes('User denied')) {
    return 'Transaction cancelled by user'
  }
  if (lower.includes('permission')) {
    return 'Permission request cancelled'
  }
  if (lower.includes('insufficient')) {
    return 'Insufficient balance for this transaction'
  }
  if (rawMessage.includes('No spendable tokens found')) {
    return 'No tokens available for this action'
  }
  if (lower.includes('network')) {
    return 'Network error. Please check your connection and try again.'
  }
  if (lower.includes('timeout')) {
    return 'Request timed out. Please try again.'
  }
  if (lower.includes('invalid')) {
    return 'Invalid transaction details. Please check and try again.'
  }

  const messageMatch = rawMessage.match(/"message"\s*:\s*"([^"]+)"/)
  if (messageMatch?.[1]) {
    return messageMatch[1]
  }

  return rawMessage.length < 120 && !rawMessage.includes('{') ? rawMessage : fallback
}
