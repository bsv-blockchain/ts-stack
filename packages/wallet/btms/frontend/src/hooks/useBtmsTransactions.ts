import { useCallback, useEffect, useState } from 'react'
import { btms, BTMSTransaction } from '../btms'

export interface UseBtmsTransactionsResult {
  transactions: BTMSTransaction[]
  loading: boolean
  error: string | null
  refresh: (assetId?: string, limit?: number, offset?: number) => Promise<void>
}

export const useBtmsTransactions = (
  assetId?: string,
  limit: number = 100,
  offset: number = 0
): UseBtmsTransactionsResult => {
  const [transactions, setTransactions] = useState<BTMSTransaction[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (desiredAssetId?: string, desiredLimit: number = limit, desiredOffset: number = offset) => {
    if (!desiredAssetId) return
    setLoading(true)
    setError(null)
    try {
      const result = await btms.getTransactions(desiredAssetId, desiredLimit, desiredOffset)
      setTransactions(result.transactions)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load transactions'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [limit, offset])

  useEffect(() => {
    if (!assetId) return
    void refresh(assetId, limit, offset)
  }, [assetId, limit, offset, refresh])

  return { transactions, loading, error, refresh }
}

export default useBtmsTransactions
