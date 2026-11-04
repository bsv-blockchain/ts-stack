import { describe, expect, it } from '@jest/globals'
import { LockingScript, Transaction } from '@bsv/sdk'
import * as api from '../index.js'

describe('package exports', () => {
  it('exposes the module, plan codec, identifier helpers and evaluation helpers', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ASSETS_SELECTOR',
      'COLOR_KEY_ID',
      'COLOR_OFFLINE_TAG',
      'COLOR_OPERATIONS',
      'COLOR_PLAN_LABEL_PREFIX',
      'ColorConsentDeclinedError',
      'ColorPermissionModule',
      'ColorPlan',
      'ISSUE',
      'ProfileDataError',
      'ProfileParamsError',
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
      'readProfiledTokenOutput',
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

  it('exports the 0.2.0 profile surface', async () => {
    const m = await import('../index.js')
    for (const name of [
      'COLOR_OFFLINE_TAG',
      'ProfileParamsError',
      'ProfileDataError',
      'ColorConsentDeclinedError',
      'UnsupportedProfileError',
      'readProfiledTokenOutput'
    ])
      expect(m).toHaveProperty(name)
    for (const method of ['markSettled', 'dispose'])
      expect(typeof (m.ColorPermissionModule.prototype as any)[method]).toBe('function')
    for (const removed of ['settle', 'isSettled', 'handoffEvidence'])
      expect((m.ColorPermissionModule.prototype as any)[removed]).toBeUndefined()
    expect(m.COLOR_OFFLINE_TAG).toBe('color_offline')
  })

  it('keeps the 0.1.0 positional transactionConsent call beside the options object', () => {
    const tx = new Transaction(
      1,
      [],
      [{ lockingScript: LockingScript.fromHex('6a'), satoshis: 0 }],
      0
    )
    const tokens = api.transactionTokens(tx)
    const consent = (last: Parameters<typeof api.transactionConsent>[6]): Record<string, unknown> =>
      api.transactionConsent(
        tx,
        tokens,
        [],
        () => false,
        () => true,
        [],
        last
      )
    expect(consent({ deployOwned: false })).toEqual(consent(false))
    const seen: number[] = []
    consent({
      deployOwned: false,
      read: (_script, outpoint) => {
        seen.push(outpoint.vout)
        return undefined
      }
    })
    expect(seen).toEqual([0])
  })
})
