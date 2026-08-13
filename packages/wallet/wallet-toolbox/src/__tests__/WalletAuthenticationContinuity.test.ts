import { WABAccountContinuityError, WalletAuthenticationManager } from '../WalletAuthenticationManager'

const temporaryKey = '11'.repeat(32)
const existingKey = '22'.repeat(32)

function subject() {
  const authMethod = { methodType: 'TwilioPhone' }
  const wabClient = {
    startAuthMethod: jest.fn(async () => ({ success: true })),
    completeAuthMethod: jest.fn(async () => ({
      success: true,
      presentationKey: temporaryKey,
      accountStatus: 'new-user'
    }))
  }
  const manager = Object.create(WalletAuthenticationManager.prototype) as WalletAuthenticationManager
  Object.assign(manager as any, {
    authenticated: false,
    authMethod,
    authSessionTtlMs: 10_000,
    wabClient,
    telemetry: {
      enabled: false,
      capture: jest.fn(),
      createCorrelationId: jest.fn(() => 'correlation')
    },
    authenticationFlow: 'new-user',
    providePresentationKey: jest.fn(async () => undefined)
  })
  return { manager, authMethod, wabClient }
}

describe('WAB authentication continuity', () => {
  it('surfaces a WAB faucet failure message before attempting wallet funding', async () => {
    const wabClient = {
      requestFaucet: jest.fn(async () => ({ success: false, message: 'faucet unavailable' }))
    }
    const manager = new WalletAuthenticationManager(
      'admin.example',
      async () => Object.create(null),
      undefined,
      async () => true,
      async () => 'password',
      wabClient as any
    )

    await expect(
      (manager as any).newWalletFunder(Array(32).fill(1), Object.create(null), 'admin.example')
    ).rejects.toThrow('Faucet request failed: faucet unavailable')
  })

  it('starts, cancels, switches, and reports failed authentication starts', async () => {
    const { manager, authMethod, wabClient } = subject()
    Object.assign(manager as any, { authMethod: undefined })
    await expect(manager.startAuth({ phoneNumber: '+12065550100' })).rejects.toThrow('No WAB authentication')

    manager.setAuthMethod(authMethod as any)
    Object.assign(manager as any, { authenticated: true })
    await expect(manager.startAuth({ phoneNumber: '+12065550100' })).rejects.toThrow('already authenticated')

    Object.assign(manager as any, { authenticated: false })
    wabClient.startAuthMethod.mockResolvedValueOnce({ success: false, message: 'start rejected' })
    await expect(manager.startAuth({ phoneNumber: '+12065550100' })).rejects.toThrow('start rejected')
    expect((manager as any).authSession).toBeUndefined()

    await expect(manager.startAuth({ phoneNumber: '+12065550100' })).resolves.toBeUndefined()
    expect((manager as any).authSession.presentationKey).toMatch(/^[0-9a-f]{64}$/)
    manager.setAuthMethod({ methodType: 'Other' } as any)
    expect((manager as any).authSession).toBeUndefined()
    manager.cancelAuth()
  })

  it('passes a WAB pin only through a successful, matching account-continuity completion', async () => {
    const { manager, wabClient } = subject()
    await manager.startAuth({ phoneNumber: '+12065550100' })
    const sessionKey = (manager as any).authSession.presentationKey as string
    const pinnedOutpoint = `${'a'.repeat(64)}.3`
    wabClient.completeAuthMethod.mockResolvedValueOnce({
      success: true,
      presentationKey: sessionKey,
      accountStatus: 'new-user',
      existingUser: false,
      umpTokenOutpoint: pinnedOutpoint
    })

    await expect(manager.completeAuth({ otp: '123456' })).resolves.toBeUndefined()
    expect((manager as any).providePresentationKey).toHaveBeenCalledWith(expect.any(Array), {
      pinnedOutpoint
    })
    expect((manager as any).authSession).toBeUndefined()
  })

  it('rejects missing, switched, expired, unsuccessful, and malformed completion state', async () => {
    const { manager, authMethod, wabClient } = subject()
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toThrow('Start WAB authentication')

    Object.assign(manager as any, {
      authSession: { presentationKey: temporaryKey, methodType: 'Other', expiresAt: Date.now() + 1000 }
    })
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toThrow('method changed')

    Object.assign(manager as any, {
      authMethod,
      authSession: { presentationKey: temporaryKey, methodType: authMethod.methodType, expiresAt: Date.now() }
    })
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toThrow('expired')

    Object.assign(manager as any, {
      authSession: { presentationKey: temporaryKey, methodType: authMethod.methodType, expiresAt: Date.now() + 1000 }
    })
    wabClient.completeAuthMethod.mockResolvedValueOnce({ success: false, message: 'bad OTP' })
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toThrow('bad OTP')

    wabClient.completeAuthMethod.mockResolvedValueOnce({ success: true, presentationKey: 'not-hex' })
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toBeInstanceOf(WABAccountContinuityError)
  })

  it('validates every additive and compatibility account-status combination', () => {
    const { manager } = subject()
    const infer = (result: Record<string, unknown>, key = temporaryKey) =>
      (manager as any).inferAccountStatus({ success: true, presentationKey: key, ...result }, temporaryKey)

    expect(infer({})).toBe('new-user')
    expect(infer({ existingUser: false })).toBe('new-user')
    expect(infer({ accountStatus: 'existing-user' }, existingKey)).toBe('existing-user')
    expect(infer({ existingUser: true }, existingKey.toUpperCase())).toBe('existing-user')
    expect(() => infer({ accountStatus: 'invalid' })).toThrow('invalid account status')
    expect(() => infer({ existingUser: 'yes' })).toThrow('invalid existing-user')
    expect(() => infer({ accountStatus: 'new-user', existingUser: true })).toThrow('conflicting account status')
    expect(() => infer({ accountStatus: 'new-user' }, existingKey)).toThrow('conflicting account status')
    expect(() => infer({ accountStatus: 'existing-user' })).toThrow('conflicting account status')
    expect(() => (manager as any).inferAccountStatus({ success: true }, temporaryKey)).toThrow(
      'did not return a presentation key'
    )
    expect((manager as any).constantTimeHexEqual('aa', 'AA')).toBe(true)
    expect((manager as any).constantTimeHexEqual('aa', 'ab')).toBe(false)
    expect((manager as any).constantTimeHexEqual('a', 'aa')).toBe(false)
    expect(new WABAccountContinuityError().code).toBe('WERR_WAB_ACCOUNT_CONTINUITY')
  })

  it('clears both authentication sessions when the manager is destroyed', () => {
    const { manager } = subject()
    Object.assign(manager as any, {
      authSession: { presentationKey: temporaryKey },
      phoneChangeSession: ['+12065550100', temporaryKey]
    })

    manager.destroy()

    expect((manager as any).authSession).toBeUndefined()
    expect((manager as any).phoneChangeSession).toBeUndefined()
    expect(manager.authenticated).toBe(false)
  })
})
