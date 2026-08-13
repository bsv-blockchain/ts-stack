import { Utils } from '@bsv/sdk'
import { WalletAuthenticationManager } from '../WalletAuthenticationManager'

function subject() {
  const currentPresentationKey = Array(32).fill(9) as number[]
  const wabClient = {
    startPhoneNumberChange: jest.fn(async () => ({ success: true })),
    completePhoneNumberChange: jest.fn(async () => ({
      success: true,
      changeToken: 'a'.repeat(64)
    })),
    commitPhoneNumberChange: jest.fn(async () => ({ success: true, changeId: 41 }))
  }
  const manager = Object.create(WalletAuthenticationManager.prototype) as WalletAuthenticationManager
  Object.assign(manager as any, {
    authenticated: true,
    wabClient,
    getFactor: jest.fn(async () => currentPresentationKey),
    changePresentationKey: jest.fn(async () => undefined)
  })
  return { manager, wabClient, currentPresentationKey }
}

describe('verified phone-number changes', () => {
  it('ignores a malformed optional WAB pin until normal UMP lookup decides ambiguity', () => {
    const { manager } = subject()
    expect(
      (manager as any).readUMPTokenOutpoint({ umpTokenOutpoint: 'not-an-outpoint' })
    ).toBeUndefined()
  })

  it('allows the currently registered number and rolls the presentation key', async () => {
    const { manager, wabClient, currentPresentationKey } = subject()

    await manager.startPhoneNumberChange('+12065550100')
    await expect(manager.completePhoneNumberChange('123456')).resolves.toEqual({ changeId: 41 })

    expect(wabClient.startPhoneNumberChange).toHaveBeenCalledWith(Utils.toHex(currentPresentationKey), '+12065550100')
    expect((manager as any).changePresentationKey).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Number)]))
    expect((manager as any).changePresentationKey.mock.calls[0][0]).toHaveLength(32)
    expect(wabClient.commitPhoneNumberChange).toHaveBeenCalledWith(
      'a'.repeat(64),
      Utils.toHex(currentPresentationKey),
      Utils.toHex((manager as any).changePresentationKey.mock.calls[0][0])
    )
  })

  it('retries the WAB commit without publishing a second UMP update', async () => {
    const { manager, wabClient } = subject()
    wabClient.commitPhoneNumberChange
      .mockResolvedValueOnce({ success: false, message: 'temporary failure' })
      .mockResolvedValueOnce({ success: true, changeId: 42 })

    await manager.startPhoneNumberChange('+12065550101')
    await expect(manager.completePhoneNumberChange('123456')).rejects.toThrow('temporary failure')
    await expect(manager.completePhoneNumberChange('123456')).resolves.toEqual({ changeId: 42 })

    expect(wabClient.completePhoneNumberChange).toHaveBeenCalledTimes(1)
    expect((manager as any).changePresentationKey).toHaveBeenCalledTimes(1)
    expect(wabClient.commitPhoneNumberChange).toHaveBeenCalledTimes(2)
  })
})
