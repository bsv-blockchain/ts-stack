import { Hash, PushDrop } from '@bsv/sdk'
import { OverlayUMPTokenInteractor, UMPToken, UMPTokenLookupError } from '../CWIStyleWalletManager'

function token(outpoint: `${string}.${number}`, presentationHash: number[]): UMPToken {
  const field = Array(32).fill(1) as number[]
  return {
    passwordSalt: field,
    passwordPresentationPrimary: field,
    passwordRecoveryPrimary: field,
    presentationRecoveryPrimary: field,
    passwordPrimaryPrivileged: field,
    presentationRecoveryPrivileged: field,
    presentationHash,
    recoveryHash: Array(32).fill(2) as number[],
    presentationKeyEncrypted: field,
    passwordKeyEncrypted: field,
    recoveryKeyEncrypted: field,
    currentOutpoint: outpoint
  }
}

function resolution() {
  return {
    answer: { type: 'output-list' as const, outputs: [] },
    progress: {
      type: 'output-list' as const,
      outputs: [],
      txIds: [],
      isFinal: true,
      hostCount: 2,
      completedHosts: 2,
      successfulHosts: 2,
      emptyHosts: 0,
      failedHosts: 0,
      rejectedHosts: 0,
      freeformHosts: 0
    }
  }
}

describe('WAB-administered UMP pin fallback', () => {
  const presentationKey = Array(32).fill(7) as number[]
  const presentationHash = Hash.sha256(presentationKey)
  const firstOutpoint = `${'a'.repeat(64)}.0` as const
  const secondOutpoint = `${'b'.repeat(64)}.1` as const

  function interactor() {
    const resolver = { queryDetailed: jest.fn(async () => resolution()) }
    const subject = new OverlayUMPTokenInteractor(resolver as any, {} as any)
    const first = token(firstOutpoint, presentationHash)
    const second = token(secondOutpoint, presentationHash)
    jest.spyOn(subject as any, 'parseLookupAnswers').mockReturnValue([first, second])
    return { subject, first, second }
  }

  it('uses the pin only after normal lineage resolution remains ambiguous', async () => {
    const { subject, second } = interactor()
    jest.spyOn(subject as any, 'resolveNewestToken').mockReturnValue(undefined)

    await expect(subject.findByPresentationKeyHash(presentationHash, { pinnedOutpoint: secondOutpoint })).resolves.toBe(
      second
    )
  })

  it('keeps the normal lineage winner even when the WAB pin names another candidate', async () => {
    const { subject, first } = interactor()
    jest.spyOn(subject as any, 'resolveNewestToken').mockReturnValue(first)

    await expect(subject.findByPresentationKeyHash(presentationHash, { pinnedOutpoint: secondOutpoint })).resolves.toBe(
      first
    )
  })

  it('does not accept a pin that is absent from the verified matching candidates', async () => {
    const { subject } = interactor()
    jest.spyOn(subject as any, 'resolveNewestToken').mockReturnValue(undefined)

    await expect(
      subject.findByPresentationKeyHash(presentationHash, {
        pinnedOutpoint: `${'c'.repeat(64)}.0`
      })
    ).rejects.toMatchObject<Partial<UMPTokenLookupError>>({ reason: 'token-ambiguous' })
  })

  it('builds and broadcasts a finalized UMP token through the shared action path', async () => {
    const { subject, first } = interactor()
    const finalizedOutpoint = `${'d'.repeat(64)}.0` as const
    const lock = jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue({ toHex: () => '51' } as any)
    const fields = jest.spyOn(subject as any, 'tokenFields').mockReturnValue([])
    const oldInput = jest.spyOn(subject as any, 'resolveOldInput').mockResolvedValue({
      resolvedOldToken: undefined,
      inputToken: undefined
    })
    const createAction = jest.spyOn(subject as any, 'createAction').mockResolvedValue({ txid: 'd'.repeat(64) })
    const broadcastFinal = jest.spyOn(subject as any, 'broadcastFinal').mockResolvedValue(finalizedOutpoint)

    await expect(subject.buildAndSend({} as any, 'admin.example', first)).resolves.toBe(finalizedOutpoint)
    expect(fields).toHaveBeenCalledWith(first)
    expect(oldInput).toHaveBeenCalledWith(undefined)
    expect(createAction).toHaveBeenCalledWith(
      expect.anything(),
      'admin.example',
      [],
      [{ lockingScript: '51', satoshis: 1, outputDescription: 'New UMP token output' }],
      undefined,
      undefined
    )
    expect(broadcastFinal).toHaveBeenCalledWith({ txid: 'd'.repeat(64) })
    lock.mockRestore()
  })
})
