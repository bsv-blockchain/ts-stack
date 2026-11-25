# @bsv/amountinator-react

React helpers for displaying and entering currency amounts using
[`@bsv/amountinator`](https://www.npmjs.com/package/@bsv/amountinator).

This package gives you:

- `AmountDisplay` for rendering converted/formatted amounts
- `AmountInputField` for collecting user input and converting to satoshis
- `useCurrencyDisplay` for headless/custom UI formatting

All conversions/formatting are based on the user's preferred currency from
their BRC-100 wallet settings.

## Installation

```bash
npm install @bsv/amountinator-react
```

## Exports

```ts
import {
  AmountDisplay,
  AmountInputField,
  useCurrencyDisplay
} from '@bsv/amountinator-react'
```

---

## AmountDisplay

Render an amount in the user's preferred currency.

### Basic example

```tsx
import React from 'react'
import { AmountDisplay } from '@bsv/amountinator-react'

export const PaymentAmount = () => {
  return <AmountDisplay paymentAmount={1500} />
}
```

### With format options

```tsx
import React from 'react'
import { AmountDisplay } from '@bsv/amountinator-react'

export const FormattedAmount = () => {
  return (
    <AmountDisplay
      paymentAmount='12345 SATS'
      formatOptions={{
        useCommas: true,
        decimalPlaces: 2
      }}
    />
  )
}
```

### Small-amount behavior

- For decimal currencies (e.g. USD, BSV), very small values can render as `< 0.01`.
- On hover, a more precise amount is shown.
- For zero-decimal currencies (e.g. SATS, JPY), decimals are never shown.

### Props

| Prop | Type | Required | Description |
| --- | --- | --- | --- |
| `paymentAmount` | `number \| string` | Yes | Amount to convert/format |
| `formatOptions` | `FormatOptions` | No | Decimal places + separators |

`FormatOptions`:

```ts
interface FormatOptions {
  decimalPlaces?: number
  useCommas?: boolean
  useUnderscores?: boolean
}
```

---

## AmountInputField

Input component that emits converted satoshis via callback.

```tsx
import React, { useState } from 'react'
import { AmountInputField } from '@bsv/amountinator-react'

export const SendForm = () => {
  const [sats, setSats] = useState<number | null>(null)

  return (
    <div>
      <AmountInputField onSatoshisChange={setSats} />
      <p>Satoshis: {sats ?? '—'}</p>
    </div>
  )
}
```

### Props

| Prop | Type | Required | Description |
| --- | --- | --- | --- |
| `onSatoshisChange` | `(sats: number \| null) => void` | Yes | Called when parsed value changes |

---

## useCurrencyDisplay

Headless hook for custom layouts.

```tsx
import React from 'react'
import { useCurrencyDisplay } from '@bsv/amountinator-react'

export const CustomAmount = () => {
  const { displayAmount, error } = useCurrencyDisplay('0.000001 BSV', {
    useCommas: true
  })

  if (error) return <span>Failed to load amount</span>

  return <strong>{displayAmount}</strong>
}
```

### Return shape

```ts
{
  displayAmount: string
  error: Error | null
}
```

---

## Amount input notes

`paymentAmount` supports both `number` and `string` values.

For explicit behavior, prefer string values with currency codes, for example:

- `'1500 SATS'`
- `'0.005 BSV'`
- `'12.50 USD'`

---

## License

Apache License 2.0.
