import { formatAmountWithCurrency } from '../src/utils/amountFormatHelpers'
import { CurrencyConverter } from '../src/utils/currencyConverter'

describe('formatAmountWithCurrency', () => {
  test('infers unitless satoshi and decimal BSV amounts using the wallet currency', async () => {
    const settingsManager = {
      get: jest.fn().mockResolvedValue({ currency: 'USD' })
    } as unknown as NonNullable<ConstructorParameters<typeof CurrencyConverter>[1]>
    const converter = new CurrencyConverter(0, settingsManager)
    converter.exchangeRates.usdPerBsv = 62

    const satoshiAmount = await converter.convertAmount('10000')
    const bsvAmount = await converter.convertAmount('0.5')

    expect(satoshiAmount.formattedAmount).toBe('< $0.01')
    expect(satoshiAmount.hoverText).toBe('$0.0062')
    expect(bsvAmount.formattedAmount).toBe('$31')
    expect(settingsManager.get).toHaveBeenCalledTimes(2)
  })

  test('formats USD with default settings', () => {
    expect(formatAmountWithCurrency(1234.56, 'USD').formattedAmount).toBe('$1,234.56')
  })

  test('formats EUR with no decimals', () => {
    expect(formatAmountWithCurrency(1234, 'EUR', { decimalPlaces: 0 }).formattedAmount).toBe(
      '€1,234'
    )
  })

  test('formats GBP with underscores', () => {
    expect(
      formatAmountWithCurrency(1234567.89, 'GBP', { useUnderscores: true }).formattedAmount
    ).toBe('£1_234_567.89')
  })

  test('formats SATS with many decimals', () => {
    expect(formatAmountWithCurrency(0.000012345, 'SATS', { decimalPlaces: 9 }).hoverText).toBe(
      '0.000012345 satoshis'
    )
  })
  test('formats BSV without commas', () => {
    expect(formatAmountWithCurrency(1000, 'BSV', { useCommas: false }).formattedAmount).toBe(
      '1000 BSV'
    )
  })

  test('handles very small amounts correctly', () => {
    expect(formatAmountWithCurrency(0.00000012345, 'USD', { decimalPlaces: 10 }).hoverText).toBe(
      '$0.0000001235'
    )
  })

  test('formats very small amounts for BSV and currencies without a known symbol', () => {
    expect(formatAmountWithCurrency(0.001, 'BSV')).toEqual({
      formattedAmount: '< 0.01 BSV',
      hoverText: '0.001 BSV'
    })
    expect(formatAmountWithCurrency(0.001, 'XYZ')).toEqual({
      formattedAmount: '< XYZ 0.01',
      hoverText: 'XYZ 0.001'
    })
  })

  test('formats negative amounts correctly', () => {
    expect(formatAmountWithCurrency(-1234.56, 'EUR').hoverText).toBe('€-1,235')
  })
})
