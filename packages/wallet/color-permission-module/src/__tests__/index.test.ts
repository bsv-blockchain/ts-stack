import { describe, expect, it } from '@jest/globals'
import * as api from '../index.js'

describe('package exports', () => {
  it('exposes the module, plan codec, identifier helpers and evaluation helpers', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ASSETS_SELECTOR',
      'COLOR_KEY_ID',
      'COLOR_OPERATIONS',
      'COLOR_PLAN_LABEL_PREFIX',
      'ColorPermissionModule',
      'ColorPlan',
      'ISSUE',
      'UnsupportedProfileError',
      'actionConsent',
      'assertNoRequiredProfiles',
      'assertPlanAssets',
      'assertTransactionOperations',
      'assertUnlocks',
      'assetBasket',
      'assetTag',
      'authorityOperation',
      'colorProtocolID',
      'colorTopic',
      'createColorModule',
      'deployOperation',
      'parseAssetBasket',
      'parseBalanceSelector',
      'parseColorProtocolID',
      'readAnyTokenOutput',
      'readJsonTokenOutput',
      'readSentToken',
      'readTokenOutput',
      'requiredOperations',
      'sighashScopes',
      'submissionAssets',
      'supplyChange',
      'tokenSources',
      'transactionConsent',
      'transactionTokens',
      'tryReadTokenOutput'
    ])
    for (const value of Object.values(api)) expect(value).toBeDefined()
    expect(api.colorTopic(`${'ab'.repeat(32)}_0`)).toBe(`tm_color_${'ab'.repeat(32)}_0`)
  })
})
