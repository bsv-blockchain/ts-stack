import { useEffect, useState, useMemo } from 'react'
import { Services } from '@bsv/wallet-toolbox-client'

export const useBsvExchangeRate = (defaultRate = 70) => {
  const [rate, setRate] = useState(defaultRate)
  const services = useMemo(() => new Services('main'), [])

  useEffect(() => {
    let cancelled = false
    const refreshRate = async () => {
      try {
        const r = await services.getBsvExchangeRate()
        if (!cancelled) setRate(r)
      } catch {
        /* leave default */
      }
    }
    void refreshRate()
    return () => {
      cancelled = true
    }
  }, [services])

  return rate
}
