import React, { useState, useCallback, useId, useMemo } from 'react'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import OutlinedInput from '@mui/material/OutlinedInput'
import InputAdornment from '@mui/material/InputAdornment'
import { CurrencyConverter } from '@bsv/amountinator'
import useAsyncEffect from 'use-async-effect'

interface AmountInputFieldProps {
  onSatoshisChange: (satoshis: number | null) => void
}

const AmountInputField = ({ onSatoshisChange }: AmountInputFieldProps) => {
  const inputId = useId()
  const [amount, setAmount] = useState('')
  const [currencySymbol, setCurrencySymbol] = useState('$')
  const currencyConverter = useMemo(() => new CurrencyConverter(), [])

  useAsyncEffect(async () => {
    // Note: Handle errors at a higher layer!
    await currencyConverter.initialize()
    setCurrencySymbol(currencyConverter.getCurrencySymbol())
  }, [])

  const handleAmountChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const input = event.target.value.replace(/[^0-9.]/g, '')

      setAmount(input)

      const numericAmount = Number(input)
      if (input === '' || !Number.isFinite(numericAmount)) {
        onSatoshisChange(null)
        return
      }

      const satoshis = await currencyConverter.convertToSatoshis(numericAmount)
      onSatoshisChange(satoshis)
    },
    [currencyConverter, onSatoshisChange]
  )

  return (
    <FormControl fullWidth>
      <InputLabel htmlFor={inputId}>Enter Amount</InputLabel>
      <OutlinedInput
        id={inputId}
        label="Enter Amount"
        value={amount}
        onChange={handleAmountChange}
        startAdornment={<InputAdornment position="start">{currencySymbol}</InputAdornment>}
        sx={{ backgroundColor: 'white' }}
      />
    </FormControl>
  )
}
export default AmountInputField
