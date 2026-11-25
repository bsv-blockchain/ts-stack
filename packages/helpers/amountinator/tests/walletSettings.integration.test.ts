import type { WalletInterface } from '@bsv/sdk'
import { DEFAULT_SETTINGS, Services, WalletSettingsManager } from '@bsv/wallet-toolbox-client'
import { CurrencyConverter } from '../src'
import { SUPPORTED_FIAT_CURRENCY_CODES } from '../src/types'

test('honors the wallet currency in a complete public converter flow', async () => {
  const listOutputs = jest.fn().mockResolvedValue({ totalOutputs: 0, outputs: [] })
  const wallet = { listOutputs } as unknown as WalletInterface
  const settings = new WalletSettingsManager(wallet, {
    defaultSettings: { ...DEFAULT_SETTINGS, currency: 'BSV' }
  })
  const usdRate = jest.spyOn(Services.prototype, 'getBsvExchangeRate').mockResolvedValue(62)
  const rates = jest.spyOn(Services.prototype, 'getFiatExchangeRates').mockResolvedValue({
    timestamp: new Date(),
    base: 'USD',
    rates: Object.fromEntries(SUPPORTED_FIAT_CURRENCY_CODES.map(code => [code, 1]))
  })
  const converter = new CurrencyConverter(0, settings)
  try {
    await converter.initialize()
    expect(converter.preferredCurrency).toBe('BSV')
    expect(converter.getCurrencySymbol()).toBe('BSV')
    expect(listOutputs).toHaveBeenCalledWith(
      expect.objectContaining({ basket: 'wallet settings' }),
      undefined
    )
    await expect(converter.convertAmount('100000000 SATS')).resolves.toMatchObject({
      formattedAmount: '1 BSV'
    })
    await expect(converter.convertToSatoshis(0.00000007)).resolves.toBe(7)
    expect(converter.convertCurrency(1, 'BSV', 'USD')).toBe(62)
    expect(usdRate).toHaveBeenCalledTimes(1)
    expect(rates).toHaveBeenCalledTimes(1)
  } finally {
    converter.dispose()
    jest.restoreAllMocks()
  }
})
