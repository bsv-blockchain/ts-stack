const assert = require('node:assert/strict')
const { test } = require('node:test')
const { normalizeDisplayAmount } = require('../out/src/utils/amountDisplayFormatting.js')

test('shows whole satoshis with grouping and forwards the original amount to the converter', async () => {
  const converter = {
    preferredCurrency: 'SATS',
    convertAmount: async amount => {
      assert.equal(amount, '12345 SATS')
      return { formattedAmount: 'upstream' }
    },
    convertCurrency: (amount, input, output) => {
      assert.deepEqual([amount, input, output], [12345, 'SATS', 'SATS'])
      return amount
    }
  }
  assert.deepEqual(await normalizeDisplayAmount(converter, '12345 SATS'), {
    formattedAmount: '12,345 satoshis'
  })
})

test('preserves the regular text and adds more precision for small fiat amounts', async () => {
  const converter = {
    preferredCurrency: 'USD',
    convertAmount: async () => ({ formattedAmount: '$0.00' }),
    convertCurrency: () => 0.00125
  }
  const display = await normalizeDisplayAmount(converter, '1 SATS')
  assert.equal(display.formattedAmount, '$0.00')
  assert.equal(display.hoverText, '$0.00125')
})
