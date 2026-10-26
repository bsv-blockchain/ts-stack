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

  test.each([
    ['USD', '$'],
    ['GBP', '£'],
    ['EUR', '€'],
    ['JPY', '¥'],
    ['CNY', '¥'],
    ['INR', '₹'],
    ['AUD', 'A$'],
    ['CAD', 'C$'],
    ['CHF', 'CHF '],
    ['HKD', 'HK$'],
    ['SGD', 'S$'],
    ['NZD', 'NZ$'],
    ['SEK', 'SEK '],
    ['NOK', 'NOK '],
    ['MXN', 'MX$']
  ])('uses the canonical %s currency marker', (currency, marker) => {
    expect(formatAmountWithCurrency(1234.5, currency, { decimalPlaces: 1 }).formattedAmount).toBe(
      `${marker}1,234.5`
    )
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

  test('keeps the exact small-amount threshold and implicit decimal boundaries', () => {
    expect(formatAmountWithCurrency(0, 'USD')).toEqual({
      formattedAmount: '< $0.01',
      hoverText: '$0'
    })
    expect(formatAmountWithCurrency(0.009, 'USD')).toEqual({
      formattedAmount: '< $0.01',
      hoverText: '$0.009'
    })
    expect(formatAmountWithCurrency(0.01, 'USD')).toEqual({
      formattedAmount: '$0.01'
    })
    expect(formatAmountWithCurrency(0.1, 'USD')).toEqual({
      formattedAmount: '$0.1'
    })
    expect(formatAmountWithCurrency(1, 'USD')).toEqual({
      formattedAmount: '$1'
    })
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
    expect(formatAmountWithCurrency(-1234.56, 'EUR')).toEqual({
      formattedAmount: '€-1,234.56'
    })
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite amount %p',
    amount => {
      expect(() => formatAmountWithCurrency(amount, 'USD')).toThrow('finite number')
    }
  )

  test.each([
    [null, 'currency must be a non-empty string'],
    ['', 'currency must be a non-empty string'],
    ['   ', 'currency must be a non-empty string']
  ])('rejects malformed currency value %p', (currency, message) => {
    expect(() => formatAmountWithCurrency(1, currency as any)).toThrow(message)
  })

  test.each([-1, 0.5, 101])('rejects invalid decimalPlaces value %p', decimalPlaces => {
    expect(() => formatAmountWithCurrency(1, 'USD', { decimalPlaces })).toThrow(
      'decimalPlaces must be an integer from 0 through 100'
    )
  })

  test('accepts exact decimal and grouping boundaries and normalizes the currency code', () => {
    expect(formatAmountWithCurrency(1, ' usd ', { decimalPlaces: 0 })).toEqual({
      formattedAmount: '$1'
    })
    expect(formatAmountWithCurrency(1, 'USD', { decimalPlaces: 100 }).formattedAmount).toBe(
      `$1.${'0'.repeat(100)}`
    )
    expect(
      formatAmountWithCurrency(1234, 'USD', {
        decimalPlaces: 0,
        useCommas: false,
        useUnderscores: true
      }).formattedAmount
    ).toBe('$1_234')
  })

  test.each([
    [{ useCommas: 'yes' }, 'grouping options must be booleans'],
    [{ useUnderscores: 1 }, 'grouping options must be booleans']
  ])('rejects malformed grouping options %#', (options, message) => {
    expect(() => formatAmountWithCurrency(1, 'USD', options as any)).toThrow(message)
  })

  test('rejects malformed numeric input instead of reinterpreting it', async () => {
    const settingsManager = {
      get: jest.fn().mockResolvedValue({ currency: 'USD' })
    } as unknown as NonNullable<ConstructorParameters<typeof CurrencyConverter>[1]>
    const converter = new CurrencyConverter(0, settingsManager)
    converter.exchangeRates.usdPerBsv = 50

    await expect(converter.convertAmount('1.2.3 USD')).rejects.toThrow('valid number')
    await expect(converter.convertAmount('1,23 USD')).rejects.toThrow('valid number')
    await expect(converter.convertAmount('12 USD trailing')).rejects.toThrow('valid number')
    await expect(converter.convertAmount(Number.NaN)).rejects.toThrow('finite number')
  })

  test('accepts canonical grouped amounts and rejects invalid conversion boundaries', async () => {
    const settingsManager = {
      get: jest.fn().mockResolvedValue({ currency: 'USD' })
    } as unknown as NonNullable<ConstructorParameters<typeof CurrencyConverter>[1]>
    const converter = new CurrencyConverter(0, settingsManager)
    converter.exchangeRates.usdPerBsv = 50

    await expect(converter.convertAmount('1,000 SATS')).resolves.toMatchObject({
      formattedAmount: '< $0.01'
    })
    expect(() => converter.convertCurrency(Number.POSITIVE_INFINITY, 'USD', 'SATS')).toThrow(
      'finite number'
    )
    expect(() => converter.convertCurrency(1, 'UNKNOWN', 'UNKNOWN')).toThrow(
      'Currency not supported'
    )
    converter.exchangeRates.usdPerBsv = Number.POSITIVE_INFINITY
    expect(() => converter.convertCurrency(1, 'USD', 'BSV')).toThrow('finite number')
  })

  test('only emits safe monetary output amounts', async () => {
    const converter = new CurrencyConverter(0, {
      get: jest.fn().mockResolvedValue({ currency: 'SATS' })
    } as unknown as NonNullable<ConstructorParameters<typeof CurrencyConverter>[1]>)
    converter.preferredCurrency = 'SATS'

    await expect(converter.convertToSatoshis(-1)).rejects.toThrow('between 0')
    await expect(converter.convertToSatoshis(2_100_000_000_000_001)).rejects.toThrow('between 0')
    await expect(converter.convertToSatoshis(2_100_000_000_000_000)).resolves.toBe(
      2_100_000_000_000_000
    )
  })

  test('falls back safely for a non-string wallet currency and retries after settings failures', async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue({ currency: 42 })
    const converter = new CurrencyConverter(0, { get } as never)
    converter.exchangeRates.usdPerBsv = 50

    await expect(converter.convertAmount('1 SATS')).rejects.toThrow('temporary failure')
    await expect(converter.convertAmount('1 SATS')).resolves.toMatchObject({
      formattedAmount: '1 satoshis'
    })
    expect(get).toHaveBeenCalledTimes(2)
  })

  test.each([
    [undefined, '1 satoshis'],
    ['DOGE', '1 satoshis'],
    ['bsv', '< 0.01 BSV'],
    ['sats', '1 satoshis'],
    ['usd', '< $0.01']
  ])('normalizes wallet currency preference %p', async (currency, formattedAmount) => {
    const converter = new CurrencyConverter(0, {
      get: jest.fn().mockResolvedValue(currency === undefined ? {} : { currency })
    } as never)
    converter.exchangeRates.usdPerBsv = 50

    await expect(converter.convertAmount('1 SATS')).resolves.toMatchObject({ formattedAmount })
  })

  test('coalesces concurrent preference reads and applies the changed currency', async () => {
    let resolveSettings!: (settings: { currency: string }) => void
    const pendingSettings = new Promise<{ currency: string }>(resolve => {
      resolveSettings = resolve
    })
    const get = jest.fn().mockReturnValue(pendingSettings)
    const converter = new CurrencyConverter(60_000, { get } as never)
    converter.exchangeRates.usdPerBsv = 50

    const first = expect(converter.convertAmount('100000000 SATS')).resolves.toMatchObject({
      formattedAmount: '1 BSV'
    })
    const second = expect(converter.convertAmount('100000000 SATS')).resolves.toMatchObject({
      formattedAmount: '1 BSV'
    })
    resolveSettings({ currency: 'BSV' })

    await Promise.all([first, second])
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('surfaces an unsupported conversion result', async () => {
    const converter = new CurrencyConverter(0, {
      get: jest.fn().mockResolvedValue({ currency: 'SATS' })
    } as never)
    jest.spyOn(converter, 'convertCurrency').mockReturnValue(null)

    await expect(converter.convertAmount('1 SATS')).rejects.toThrow(
      'Unsupported currency or conversion error'
    )
  })
})
