import assert from 'node:assert/strict'
import { test } from 'vitest'
import fc from 'fast-check'
import { propertyReplayOptions } from '../../../../../config/testing/property-replay.mjs'
import { parseTokenMessage } from '../../src/BtmsPrompt/utils.ts'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal(
  propertyReplayOptions(MIN_PROPERTY_RUNS, {
    runs: process.env.FAST_CHECK_NUM_RUNS,
    seed: process.env.FAST_CHECK_SEED,
    path: process.env.FAST_CHECK_PATH
  })
)

const amount = fc.nat({ max: 1_000_000_000 })
const label = fc.string({ maxLength: 48 })
const assetId = fc.stringMatching(/^[0-9a-f]{64}$/)
const structuredMessage = fc.oneof(
  fc.record({
    type: fc.constant('btms_spend'),
    sendAmount: amount,
    changeAmount: amount,
    totalInputAmount: amount,
    tokenName: label,
    recipient: label,
    assetId
  }),
  fc.record({
    type: fc.constant('btms_burn'),
    burnAmount: amount,
    tokenName: label,
    burnAll: fc.boolean(),
    assetId
  }),
  fc.record({ type: fc.constant('btms_access'), action: label, assetId })
)

test('keeps generated spend, burn and access requests distinct and unmodified', () => {
  fc.assert(
    fc.property(structuredMessage, message => {
      assert.deepEqual(parseTokenMessage(JSON.stringify(message)), { ...message })
    })
  )
})

test('reads legacy request details and does not infer spend from unknown JSON types', () => {
  fc.assert(
    fc.property(
      amount,
      fc.stringMatching(/^[A-Z][A-Z0-9 ]{0,39}$/),
      assetId,
      (sendAmount, tokenName, id) => {
        const message = 'Spend ' + sendAmount + ' ' + tokenName + ' token(s)\n\nAsset ID: ' + id
        assert.deepEqual(parseTokenMessage(message), {
          type: 'btms_spend',
          sendAmount,
          tokenName,
          assetId: id,
          totalInputAmount: sendAmount,
          changeAmount: 0
        })
        assert.deepEqual(
          parseTokenMessage(JSON.stringify({ type: 'unknown', sendAmount, tokenName })),
          {
            type: 'btms_spend',
            sendAmount: 0,
            tokenName: 'Unknown Token',
            assetId: '',
            totalInputAmount: 0,
            changeAmount: 0
          }
        )
      }
    )
  )
})
