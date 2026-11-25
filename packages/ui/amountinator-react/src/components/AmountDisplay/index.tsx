import React, { useEffect, useMemo, useState } from 'react'
import { CurrencyConverter } from '@bsv/amountinator'
import useAsyncEffect from 'use-async-effect'
import { Tooltip, Typography } from '@mui/material'
import { DisplayAmount, FormatOptions, normalizeDisplayAmount } from '../../utils/amountDisplayFormatting'

interface AmountDisplayProps {
  paymentAmount: number | string
  formatOptions?: FormatOptions
}

const AmountDisplay = ({ paymentAmount, formatOptions }: AmountDisplayProps) => {
  const [displayAmount, setDisplayAmount] = useState<DisplayAmount>({
    formattedAmount: ''
  })
  const currencyConverter = useMemo(() => new CurrencyConverter(), [])

  useEffect(() => {
    return () => {
      currencyConverter.dispose()
    }
  }, [currencyConverter])

  useAsyncEffect(async () => {
    try {
      await currencyConverter.initialize()
      const convertedAmount = await normalizeDisplayAmount(currencyConverter, paymentAmount, formatOptions)
      setDisplayAmount(convertedAmount)
    } catch (error) {
      console.error('Failed to convert amount:', error)
      // setDisplayAmount('Error')
    }
  }, [currencyConverter, paymentAmount, formatOptions])

  return (
    <Tooltip title={displayAmount.hoverText}>
      <Typography>{displayAmount.formattedAmount}</Typography>
    </Tooltip>
  )
}
export default AmountDisplay