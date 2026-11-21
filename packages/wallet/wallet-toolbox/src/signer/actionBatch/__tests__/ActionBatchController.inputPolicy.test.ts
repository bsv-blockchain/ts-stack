import type { ValidCreateActionArgs } from '@bsv/sdk/wallet/validationHelpers'
import type { Wallet } from '../../../Wallet'
import { WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { ActionBatchController } from '../ActionBatchWorkspace'

function controller(options?: { available?: boolean; hook?: unknown }): ActionBatchController {
  const wallet = {
    storage: {
      isAvailable: () => options?.available !== false,
      getActive: () => ({ validateResolvedActionInput: options?.hook })
    }
  } as unknown as Wallet
  return new ActionBatchController(wallet, 'auto')
}

function args(overrides: Record<string, unknown> = {}): ValidCreateActionArgs {
  return {
    isNewTx: true,
    isNoSend: true,
    inputs: [],
    ...overrides
  } as ValidCreateActionArgs
}

describe('ActionBatchController input policy', () => {
  test('leaves the batch for a non-new, admin, or hooked explicit action', async () => {
    const idle = controller()
    const begin = jest.spyOn(idle as unknown as { begin: () => Promise<unknown> }, 'begin')
    await expect(idle.plan(args({ isNewTx: false }))).resolves.toBeUndefined()
    await expect(idle.plan(args({ isAdminOriginator: true }))).resolves.toBeUndefined()
    const hooked = controller({ hook: () => undefined })
    await expect(hooked.plan(args({ inputs: [{}] }))).resolves.toBeUndefined()
    expect(begin).not.toHaveBeenCalled()
  })

  test('asks storage only when it is available and the hook is a function', async () => {
    const unavailable = controller({ available: false, hook: () => undefined })
    const unavailableBegin = jest
      .spyOn(unavailable as unknown as { begin: () => Promise<unknown> }, 'begin')
      .mockResolvedValue(undefined)
    await expect(unavailable.plan(args({ inputs: [{}] }))).resolves.toBeUndefined()
    expect(unavailableBegin).toHaveBeenCalledTimes(1)

    const notAFunction = controller({ hook: 'present' })
    jest.spyOn(notAFunction as unknown as { begin: () => Promise<unknown> }, 'begin').mockResolvedValue(undefined)
    await expect(notAFunction.plan(args({ inputs: [{}] }))).resolves.toBeUndefined()

    const outputsOnly = controller({ hook: () => undefined })
    const outputsBegin = jest
      .spyOn(outputsOnly as unknown as { begin: () => Promise<unknown> }, 'begin')
      .mockResolvedValue(undefined)
    await expect(outputsOnly.plan(args())).resolves.toBeUndefined()
    expect(outputsBegin).toHaveBeenCalledTimes(1)
  })

  test('falls back when a joined action is outside the workspace or the hook refuses it', async () => {
    const outside = controller()
    ;(outside as unknown as { workspace: { references: () => boolean } }).workspace = { references: () => false }
    await expect(outside.plan(args())).resolves.toBeUndefined()

    const refused = controller()
    ;(refused as unknown as { workspace: { references: () => boolean } }).workspace = { references: () => true }
    const recover = jest.spyOn(refused as unknown as { recover: () => Promise<unknown> }, 'recover')
    recover.mockRejectedValueOnce(new WERR_INVALID_PARAMETER('resolvedInputHook', 'legacy'))
    const wrapped = new Error('wrapped')
    Object.assign(wrapped, { code: 'WERR_INVALID_PARAMETER', parameter: 'resolvedInputHook' })
    recover.mockRejectedValueOnce(wrapped)
    recover.mockRejectedValueOnce('not-an-error')
    recover.mockRejectedValueOnce(null)
    recover.mockRejectedValueOnce(new WERR_INVALID_PARAMETER('firstAction', 'other'))
    await expect(refused.plan(args())).resolves.toBeUndefined()
    await expect(refused.plan(args())).resolves.toBeUndefined()
    await expect(refused.plan(args())).rejects.toBe('not-an-error')
    await expect(refused.plan(args())).rejects.toBeNull()
    await expect(refused.plan(args())).rejects.toMatchObject({ parameter: 'firstAction' })
    expect((refused as unknown as { workspace?: unknown }).workspace).toBeDefined()
  })

  test('a first action that cannot be reserved keeps the legacy path and retires a failed plan', async () => {
    const reserved = controller()
    jest
      .spyOn(reserved as unknown as { begin: () => Promise<unknown> }, 'begin')
      .mockRejectedValueOnce(new WERR_INVALID_PARAMETER('resolvedInputHook', 'legacy'))
      .mockRejectedValueOnce(new Error('storage down'))
      .mockResolvedValueOnce(undefined)
    await expect(reserved.plan(args())).resolves.toBeUndefined()
    await expect(reserved.plan(args())).rejects.toThrow('storage down')
    await expect(reserved.plan(args({ isNoSend: false }))).resolves.toBeUndefined()
    await expect(reserved.plan(args())).resolves.toBeUndefined()

    const failed = controller()
    const retire = jest.spyOn(failed as unknown as { retire: () => Promise<void> }, 'retire').mockResolvedValue()
    const capacity = { plan: jest.fn().mockRejectedValue(new WERR_INVALID_PARAMETER('firstAction', 'fit')) }
    const broken = { plan: jest.fn().mockRejectedValue(new Error('plan failed')) }
    jest
      .spyOn(failed as unknown as { begin: () => Promise<unknown> }, 'begin')
      .mockResolvedValueOnce(capacity)
      .mockResolvedValueOnce(broken)
    await expect(failed.plan(args())).resolves.toBeUndefined()
    await expect(failed.plan(args())).rejects.toThrow('plan failed')
    expect(retire).toHaveBeenCalledTimes(2)
    expect(capacity.plan).toHaveBeenCalledTimes(1)
    expect(broken.plan).toHaveBeenCalledTimes(1)
  })
})
