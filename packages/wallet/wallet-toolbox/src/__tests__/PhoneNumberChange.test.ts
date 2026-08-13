import { Utils } from '@bsv/sdk'
import { WalletAuthenticationManager } from '../WalletAuthenticationManager'

function subject() {
  const currentPresentationKey = Array(32).fill(9) as number[]
  const commitResponses: Array<{ success: boolean; changeId?: number; message?: string }> = [
    { success: true, changeId: 41 }
  ]
  const request = jest.fn(async (path: string) => {
    if (path.endsWith('/start')) return { success: true }
    if (path.endsWith('/complete')) return { success: true, changeToken: 'a'.repeat(64) }
    return commitResponses.shift() ?? { success: true, changeId: 41 }
  })
  const wabClient = {
    transport: { request }
  }
  const manager = Object.create(WalletAuthenticationManager.prototype) as WalletAuthenticationManager
  Object.assign(manager as any, {
    authenticated: true,
    wabClient,
    getFactor: jest.fn(async () => currentPresentationKey),
    changePresentationKey: jest.fn(async () => undefined)
  })
  return { manager, request, commitResponses, currentPresentationKey }
}

describe('verified phone-number changes', () => {
  it('allows the currently registered number and rolls the presentation key', async () => {
    const { manager, request, currentPresentationKey } = subject()

    await manager.startPhoneNumberChange('+12065550100')
    await expect(manager.completePhoneNumberChange('123456')).resolves.toEqual({ changeId: 41 })

    expect(request).toHaveBeenNthCalledWith(1, '/auth/phone-change/start', {
      operation: 'phone-change',
      body: { presentationKey: Utils.toHex(currentPresentationKey), phoneNumber: '+12065550100' }
    })
    expect((manager as any).changePresentationKey).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Number)]))
    expect((manager as any).changePresentationKey.mock.calls[0][0]).toHaveLength(32)
    expect(request).toHaveBeenNthCalledWith(3, '/auth/phone-change/commit', {
      operation: 'phone-change',
      body: {
        changeToken: 'a'.repeat(64),
        presentationKey: Utils.toHex(currentPresentationKey),
        newPresentationKey: Utils.toHex((manager as any).changePresentationKey.mock.calls[0][0])
      }
    })
  })

  it('retries the WAB commit without publishing a second UMP update', async () => {
    const { manager, request, commitResponses } = subject()
    commitResponses.splice(0, 1, { success: false, message: 'temporary failure' }, { success: true, changeId: 42 })

    await manager.startPhoneNumberChange('+12065550101')
    await expect(manager.completePhoneNumberChange('123456')).rejects.toThrow('temporary failure')
    await expect(manager.completePhoneNumberChange('123456')).resolves.toEqual({ changeId: 42 })

    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1)
    expect((manager as any).changePresentationKey).toHaveBeenCalledTimes(1)
    expect(request.mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(2)
  })
})
