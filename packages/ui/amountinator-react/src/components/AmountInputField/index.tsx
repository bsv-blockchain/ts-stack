import React, { useState, useCallback, useMemo } from 'react'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import { CurrencyConverter } from '@bsv/amountinator'
import useAsyncEffect from 'use-async-effect'

const AmountInputField = ({ onSatoshisChange }) => {
  const [amount, setAmount] = useState('')
  const [currencySymbol, setCurrencySymbol] = useState('$')
  const currencyConverter = useMemo(() => new CurrencyConverter(), [])

  useAsyncEffect(async () => {
    // Note: Handle errors at a higher layer!
    await currencyConverter.initialize()
    setCurrencySymbol(currencyConverter.getCurrencySymbol())
  }, [])

  const handleAmountChange = useCallback(async (event) => {
    const input = event.target.value.replace(/[^0-9.]/g, '')

    setAmount(input)

    // Note: Handle errors at a higher layer!
    if (input === '' || input === '.' || input === '..') {
      onSatoshisChange(null)
      return
    }

    const satoshis = await currencyConverter.convertToSatoshis(input)
    onSatoshisChange(satoshis)
  }, [currencyConverter, onSatoshisChange])

  return (
    <TextField
      label="Enter Amount"
      variant="outlined"
      value={amount}
      onChange={handleAmountChange}
      InputProps={{
        startAdornment: <InputAdornment position="start">{currencySymbol}</InputAdornment>
      }}
      sx={{ backgroundColor: 'white' }}
      fullWidth
    />
  )
}
export default AmountInputField