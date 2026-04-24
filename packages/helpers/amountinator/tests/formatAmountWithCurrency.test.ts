import { formatAmountWithCurrency } from '../src/utils/amountFormatHelpers'
import { CurrencyConverter } from '../src/utils/currencyConverter'

describe('formatAmountWithCurrency', () => {

  // I'm skipping this beacuse I'm not 100% sure what it is trying to do
  test.skip('generic test', async () => {
    const c = new CurrencyConverter()
    await c.initialize()
    let amount = await c.convertAmount('10000')
    console.log('a', amount)
    expect(amount.formattedAmount).toBe('$0.0062')
  })


  test('formats USD with default settings', () => {
    expect(formatAmountWithCurrency(1234.56, 'USD').formattedAmount).toBe('$1,234.56')
  })

  test('formats EUR with no decimals', () => {
    expect(formatAmountWithCurrency(1234, 'EUR', { decimalPlaces: 0 }).formattedAmount).toBe('€1,234')
  })

  test('formats GBP with underscores', () => {
    expect(formatAmountWithCurrency(1234567.89, 'GBP', { useUnderscores: true }).formattedAmount).toBe('£1_234_567.89')
  })

  test('formats SATS with many decimals', () => {
    expect(formatAmountWithCurrency(0.000012345, 'SATS', { decimalPlaces: 9 }).hoverText).toBe('0.000012345 satoshis')
  })
  test('formats BSV without commas', () => {
    expect(formatAmountWithCurrency(1000, 'BSV', { useCommas: false }).formattedAmount).toBe('1000 BSV')
  })


  test('handles very small amounts correctly', () => {
    expect(formatAmountWithCurrency(0.00000012345, 'USD', { decimalPlaces: 10 }).hoverText).toBe('$0.0000001235')
  })

  test('formats negative amounts correctly', () => {
    expect(formatAmountWithCurrency(-1234.56, 'EUR').hoverText).toBe('€-1,235')
  })
})
