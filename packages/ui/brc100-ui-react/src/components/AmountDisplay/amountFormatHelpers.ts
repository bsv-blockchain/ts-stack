const localeDefault = Intl.NumberFormat().resolvedOptions().locale?.split('-u-')[0] || 'en-US'
const groupDefault =
  Intl.NumberFormat(localeDefault)
    .formatToParts(10234.56)
    .find(p => p.type === 'group')?.value ?? ','
const decimalDefault =
  Intl.NumberFormat(localeDefault)
    .formatToParts(1234.56)
    .find(p => p.type === 'decimal')?.value ?? '.'

export const satoshisOptions = {
  fiatFormats: [
    {
      name: 'USD',
      // value suitable as first arg for Intl.NumberFormat or null for default locale
      locale: 'en-US',
      // value suitable as currency property of second arg for Intl.NumberFormat
      currency: 'USD'
    },
    {
      name: 'USD_locale',
      locale: null,
      currency: 'USD'
    },
    {
      name: 'EUR',
      locale: null,
      currency: 'EUR'
    },
    {
      name: 'GBP',
      locale: null,
      currency: 'GBP'
    }
  ],
  satsFormats: [
    {
      // Format name for settings choice lookup
      name: 'SATS',
      // One of: 'SATS', 'BSV', 'mBSV'
      // 100,000,000 SATS === 1000 mBSV === 1 BSV
      unit: 'SATS',
      // string to insert between integer and fraction parts, null for locale default
      decimal: null,
      // string to insert every three digits from decimal, null for locale default
      group: null,
      // full unit label
      label: 'satoshis',
      // abbreviated unit label
      abbrev: 'sats'
    },
    {
      name: 'SATS_Tone',
      unit: 'SATS',
      decimal: '.',
      group: '_',
      label: 'satoshis',
      abbrev: 'sats'
    },
    {
      name: 'mBSV',
      unit: 'mBSV',
      decimal: null,
      group: null,
      label: 'mBSV',
      abbrev: ''
    },
    {
      name: 'mBSV_Tone',
      unit: 'mBSV',
      decimal: '.',
      group: '_',
      label: 'mBSV',
      abbrev: ''
    },
    {
      name: 'BSV',
      unit: 'BSV',
      decimal: null,
      group: null,
      label: 'BSV',
      abbrev: ''
    },
    {
      name: 'BSV_Tone',
      unit: 'BSV',
      decimal: '.',
      group: '_',
      label: 'BSV',
      abbrev: ''
    }
  ],
  isFiatPreferred: false // If true, fiat format is preferred, else satsFormat
}

export const formatSatoshisAsFiat = (
  satoshis = Number.NaN,
  satoshisPerUSD = null,
  format: any = null,
  settingsCurrency = 'SATS',
  eurPerUSD = 0.93,
  gbpPerUSD = 0.79,
  showFiatAsInteger = false
) => {
  if (settingsCurrency) {
    // See if requested currency matches a known fiat format, if not use 'USD'
    format =
      satoshisOptions.fiatFormats.find(f => f.name === settingsCurrency) ??
      satoshisOptions.fiatFormats[0]
  }
  format ??= satoshisOptions.fiatFormats[0]
  const locale = format.locale ?? localeDefault

  const usd =
    satoshisPerUSD && Number.isInteger(Number(satoshis)) ? satoshis / satoshisPerUSD : Number.NaN
  if (Number.isNaN(usd)) return '...'

  const minimumFractionDigits = showFiatAsInteger ? 0 : fiatPrecision(Math.abs(usd))
  const options = { currency: format.currency, style: 'currency' as const, minimumFractionDigits }
  switch (format.currency) {
    case 'USD':
      return new Intl.NumberFormat(locale, {
        ...options,
        maximumFractionDigits: showFiatAsInteger ? 0 : undefined
      }).format(usd)
    case 'EUR':
      return formatQuotedCurrency(usd * eurPerUSD, locale, options)
    case 'GBP':
      return formatQuotedCurrency(usd * gbpPerUSD, locale, options)
    default:
      return undefined
  }
}

function fiatPrecision(amount: number): number {
  if (amount < 0.001) return 6
  if (amount < 0.01) return 5
  if (amount < 0.1) return 4
  if (amount < 1) return 3
  return 2
}

function formatQuotedCurrency(amount: number, locale: string, options: Intl.NumberFormatOptions) {
  if (Number.isNaN(amount)) return '...'
  return new Intl.NumberFormat(locale, options).format(amount)
}

function splitInteger(value: string, group: string, decimal: string, unit: string) {
  const layouts = {
    BSV: {
      minLength: 9,
      chunks: [
        [2, group],
        [3, group],
        [3, decimal],
        [3, group],
        [3, group]
      ]
    },
    mBSV: {
      minLength: 6,
      chunks: [
        [2, group],
        [3, decimal],
        [3, group],
        [3, group],
        [3, group]
      ]
    },
    SATS: {
      minLength: 0,
      chunks: [
        [3, group],
        [3, group],
        [3, group],
        [3, group],
        [3, group]
      ]
    }
  } as const
  const { minLength, chunks } = unit === 'BSV' || unit === 'mBSV' ? layouts[unit] : layouts.SATS
  let remaining = value.padStart(minLength, '0')
  let result = ''
  for (const [width, separator] of chunks) {
    result = remaining.slice(-width) + result
    remaining = remaining.slice(0, -width)
    if (remaining.length === 0) return result
    result = separator + result
  }
  return remaining + result
}

export const formatSatoshis = (
  satoshis: any,
  showPlus = false,
  abbreviate = false,
  format: any = null,
  settingsCurrency = 'SATS'
) => {
  if (settingsCurrency) {
    format =
      satoshisOptions.satsFormats.find(f => f.name === settingsCurrency) ??
      satoshisOptions.satsFormats[0]
  }
  format ??= satoshisOptions.satsFormats[0]
  const amount = Number(satoshis)
  if (!Number.isInteger(amount)) return '---'
  const positiveSign = showPlus ? '+' : ''
  const sign = amount < 0 ? '-' : positiveSign
  const group = format.group ?? groupDefault
  const decimal = format.decimal ?? decimalDefault
  const formatted = splitInteger(Math.abs(amount).toFixed(0), group, decimal, format.unit)
  const label = abbreviate ? format.abbrev : format.label
  return label ? `${sign}${formatted} ${label}` : `${sign}${formatted}`
}
