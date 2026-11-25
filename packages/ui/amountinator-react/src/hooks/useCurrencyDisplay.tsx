import { useState, useEffect, useMemo } from 'react'
import { CurrencyConverter } from '@bsv/amountinator'
import useAsyncEffect from 'use-async-effect'
import { FormatOptions, normalizeDisplayAmount } from '../utils/amountDisplayFormatting'

const useCurrencyDisplay = (amount: string | number, formatOptions?: FormatOptions) => {
  const [displayAmount, setDisplayAmount] = useState<string>('')
  const [isInitialized, setIsInitialized] = useState<boolean>(false)
  const [error, setError] = useState<Error | null>(null)
  const currencyConverter = useMemo(() => new CurrencyConverter(), [])

  useEffect(() => {

    // Initialize the currency converter
    const initialize = async () => {
      try {
        await currencyConverter.initialize()
        setIsInitialized(true)
      } catch (err) {
        setError(err as Error)
      }
    }

    initialize()

    return () => {
      currencyConverter.dispose()
    }
  }, [currencyConverter])

  useAsyncEffect(async () => {
    if (isInitialized) {
      try {
        const finalAmountToDisplay = await normalizeDisplayAmount(currencyConverter, amount, formatOptions)
        setDisplayAmount(finalAmountToDisplay.formattedAmount)
      } catch (err) {
        setError(err as Error)
      }
    }
  }, [amount, formatOptions, isInitialized, currencyConverter])

  return { displayAmount, error }
}
export default useCurrencyDisplay