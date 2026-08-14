import { Utils } from '@bsv/sdk'
import { WalletAuthenticationManager } from '../WalletAuthenticationManager'

function subject() {
  const currentPresentationKey = Array(32).fill(9) as number[]
  const commitResponses: Array<{ success: boolean; changeId?: number; message?: string }> = [
    { success: true, changeId: 41 }
  ]
  const finalizeResponses: Array<{ success: boolean; changeId?: number; message?: string }> = [
    { success: true, changeId: 41 }
  ]
  const request = jest.fn(async (path: string) => {
    if (path.endsWith('/start')) return { success: true }
    if (path.endsWith('/complete')) return { success: true, changeToken: 'a'.repeat(64) }
    if (path.endsWith('/commit')) return commitResponses.shift() ?? { success: true, changeId: 41 }
    return finalizeResponses.shift() ?? { success: true, changeId: 41 }
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
  return { manager, request, commitResponses, finalizeResponses, currentPresentationKey }
}

describe('verified phone-number changes', () => {
  it('requires an authenticated wallet and a successful WAB start', async () => {
    const { manager, request } = subject()
    Object.assign(manager as any, { authenticated: false })
    await expect(manager.startPhoneNumberChange('+12065550100')).rejects.toThrow('Not authenticated')

    Object.assign(manager as any, { authenticated: true })
    request.mockResolvedValueOnce({ success: false, message: 'cannot send OTP' })
    await expect(manager.startPhoneNumberChange(' +12065550100 ')).rejects.toThrow('cannot send OTP')
  })

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
    expect(request).toHaveBeenNthCalledWith(4, '/auth/phone-change/finalize', {
      operation: 'phone-change',
      body: {
        changeId: 41,
        presentationKey: Utils.toHex(currentPresentationKey),
        newPresentationKey: Utils.toHex((manager as any).changePresentationKey.mock.calls[0][0])
      }
    })
    expect(request.mock.invocationCallOrder[2]).toBeLessThan(
      (manager as any).changePresentationKey.mock.invocationCallOrder[0]
    )
  })

  it('retries finalization without publishing a second UMP update', async () => {
    const { manager, request, finalizeResponses } = subject()
    finalizeResponses.splice(0, 1, { success: false, message: 'finalize unavailable' }, { success: true, changeId: 41 })

    await manager.startPhoneNumberChange('+12065550103')
    await expect(manager.completePhoneNumberChange('123456')).rejects.toThrow('finalize unavailable')
    await expect(manager.completePhoneNumberChange('123456')).resolves.toEqual({ changeId: 41 })

    expect((manager as any).changePresentationKey).toHaveBeenCalledTimes(1)
    expect(request.mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(1)
    expect(request.mock.calls.filter(([path]) => path.endsWith('/finalize'))).toHaveLength(2)
  })

  it('resumes a staged change after the app restarts', async () => {
    const { manager, request, currentPresentationKey } = subject()
    const pendingPresentationKey = 'b'.repeat(64)
    request.mockImplementationOnce(async () => ({ success: true }))
    request.mockImplementationOnce(async () => ({
      success: true,
      pendingPresentationKey,
      pendingPhoneChangeId: 73
    }))
    request.mockImplementationOnce(async () => ({ success: true, changeId: 73 }))

    await manager.startPhoneNumberChange('+12065550104')
    await expect(manager.completePhoneNumberChange('123456')).resolves.toEqual({ changeId: 73 })

    expect(request.mock.calls.some(([path]) => path.endsWith('/commit'))).toBe(false)
    expect((manager as any).changePresentationKey).toHaveBeenCalledWith(
      Utils.toArray(pendingPresentationKey, 'hex')
    )
    expect(request).toHaveBeenLastCalledWith('/auth/phone-change/finalize', {
      operation: 'phone-change',
      body: {
        changeId: 73,
        presentationKey: Utils.toHex(currentPresentationKey),
        newPresentationKey: pendingPresentationKey
      }
    })
  })

  it('retries the WAB commit without publishing a second UMP update', async () => {
    const { manager, request, commitResponses, finalizeResponses } = subject()
    commitResponses.splice(0, 1, { success: false, message: 'temporary failure' }, { success: true, changeId: 42 })
    finalizeResponses.splice(0, 1, { success: true, changeId: 42 })

    await manager.startPhoneNumberChange('+12065550101')
    await expect(manager.completePhoneNumberChange('123456')).rejects.toThrow('temporary failure')
    await expect(manager.completePhoneNumberChange('123456')).resolves.toEqual({ changeId: 42 })

    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1)
    expect((manager as any).changePresentationKey).toHaveBeenCalledTimes(1)
    expect(request.mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(2)
  })

  it('rejects missing sessions, unsuccessful authorization, and invalid commits', async () => {
    const { manager, request, commitResponses } = subject()
    await expect(manager.completePhoneNumberChange('123456')).rejects.toThrow('No phone change')

    await manager.startPhoneNumberChange('+12065550102')
    request.mockResolvedValueOnce({ success: false, message: 'wrong OTP' })
    await expect(manager.completePhoneNumberChange(' bad ')).rejects.toThrow('wrong OTP')

    request.mockResolvedValueOnce({ success: true, changeToken: '' })
    await expect(manager.completePhoneNumberChange('123456')).rejects.toThrow('Phone change failed')

    commitResponses.splice(0, 1, { success: true, changeId: 0 })
    await expect(manager.completePhoneNumberChange('123456')).rejects.toThrow('Phone change failed')
    manager.cancelPhoneNumberChange()
    await expect(manager.completePhoneNumberChange('123456')).rejects.toThrow('No phone change')
  })
})
