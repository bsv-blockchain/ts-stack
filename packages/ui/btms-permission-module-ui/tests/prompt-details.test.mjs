import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTokenMessage } from '../dist/BtmsPrompt/utils.js'

test('preserves a structured BTMS spend request', () => {
  const message = {
    type: 'btms_spend',
    tokenName: 'Credits',
    sendAmount: 10,
    assetId: 'test-asset'
  }
  assert.deepEqual(parseTokenMessage(JSON.stringify(message)), message)
})

test('reads amount, asset ID and token name from a legacy permission request', () => {
  assert.deepEqual(
    parseTokenMessage('Spend 10 Credits token(s)\n\nAsset ID: test-asset\nApp: example'),
    {
      type: 'btms_spend',
      tokenName: 'Credits',
      sendAmount: 10,
      assetId: 'test-asset',
      changeAmount: 0,
      totalInputAmount: 10
    }
  )
})
