import { useCallback, useEffect, useState } from 'react'
import { btms, IncomingToken } from '../btms'

export interface UseBtmsIncomingResult {
  incoming: IncomingToken[]
  loading: boolean
  error: string | null
  refresh: (assetId?: string) => Promise<void>
}

export const useBtmsIncoming = (
  assetId?: string,
  options: { auto?: boolean } = {}
): UseBtmsIncomingResult => {
  const [incoming, setIncoming] = useState<IncomingToken[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (desiredAssetId?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await btms.listIncoming(desiredAssetId)
      setIncoming(Array.isArray(result) ? result : [])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load incoming payments'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (options.auto === false) return
    void refresh(assetId)
  }, [assetId, options.auto, refresh])

  return { incoming, loading, error, refresh }
}

export default useBtmsIncoming
