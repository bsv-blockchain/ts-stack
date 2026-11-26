import { useCallback, useEffect, useState } from 'react'
import { btms } from '../btms'
import { AssetView, toAssetView } from '../btms/types'

export interface UseBtmsAssetsResult {
  assets: AssetView[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export const useBtmsAssets = (): UseBtmsAssetsResult => {
  const [assets, setAssets] = useState<AssetView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const coreAssets = await btms.listAssets()
      setAssets(coreAssets.map(toAssetView))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load assets'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { assets, loading, error, refresh }
}

export default useBtmsAssets
