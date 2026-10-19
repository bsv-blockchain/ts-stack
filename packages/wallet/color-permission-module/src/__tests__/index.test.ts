import { describe, expect, it } from '@jest/globals'
import * as api from '../index.js'

describe('package exports', () => {
  it('exposes the module, plan codec and identifier helpers', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ASSETS_SELECTOR',
      'COLOR_KEY_ID',
      'COLOR_OPERATIONS',
      'COLOR_PLAN_LABEL_PREFIX',
      'ColorPermissionModule',
      'ColorPlan',
      'ISSUE',
      'assetBasket',
      'assetTag',
      'colorLookupService',
      'colorProtocolID',
      'colorTopic',
      'createColorModule',
      'parseAssetBasket',
      'parseBalanceSelector',
      'parseColorProtocolID'
    ])
    for (const value of Object.values(api)) expect(value).toBeDefined()
    expect(api.colorTopic(`${'ab'.repeat(32)}_0`)).toBe(`tm_color_${'ab'.repeat(32)}_0`)
    expect(api.colorLookupService(`${'ab'.repeat(32)}_0`)).toBe(`ls_color_${'ab'.repeat(32)}_0`)
  })
})
