import { LookupResolver, LookupResolution, WalletInterface } from '@bsv/sdk'
import {
  CWIStyleWalletManager,
  OverlayUMPTokenInteractor,
  UMPToken,
  UMPTokenInteractor,
  UMPTokenLookupError
} from '../CWIStyleWalletManager'

function resolverWith(lookup: (host: string) => Promise<{ type: 'output-list'; outputs: [] }>): LookupResolver {
  return new LookupResolver({
    facilitator: { lookup },
    hostOverrides: {
      ls_users: ['https://one.example', 'https://two.example']
    },
    reputationStorage: {
      get: () => undefined,
      set: () => {}
    }
  })
}

function resolutionWith(outputCount: number, progress: Partial<LookupResolution['progress']> = {}): LookupResolution {
  const outputs = Array.from({ length: outputCount }, (_, index) => ({
    beef: [index + 1],
    outputIndex: 0
  }))
  const hostCount = progress.hostCount ?? 1
  return {
    answer: {
      type: 'output-list',
      outputs
    },
    progress: {
      type: 'output-list',
      outputs,
      txIds: outputs.map((_, index) => (index + 1).toString(16).padStart(64, '0')),
      isFinal: progress.isFinal ?? true,
      hostCount,
      completedHosts: progress.completedHosts ?? hostCount,
      successfulHosts: progress.successfulHosts ?? hostCount,
      emptyHosts: progress.emptyHosts ?? 0,
      failedHosts: progress.failedHosts ?? 0,
      rejectedHosts: progress.rejectedHosts ?? 0,
      freeformHosts: progress.freeformHosts ?? 0,
      ...(progress.correlationId !== undefined ? { correlationId: progress.correlationId } : {})
    }
  }
}

function tokenForPresentationHash(hashByte: number, outpointByte = 'a'): UMPToken {
  const fields = Array.from({ length: 11 }, () => Array.from({ length: 32 }).fill(1))
  return {
    passwordSalt: fields[0],
    passwordPresentationPrimary: fields[1],
    passwordRecoveryPrimary: fields[2],
    presentationRecoveryPrimary: fields[3],
    passwordPrimaryPrivileged: fields[4],
    presentationRecoveryPrivileged: fields[5],
    presentationHash: Array.from({ length: 32 }).fill(hashByte),
    recoveryHash: fields[7],
    presentationKeyEncrypted: fields[8],
    passwordKeyEncrypted: fields[9],
    recoveryKeyEncrypted: fields[10],
    currentOutpoint: `${outpointByte.repeat(64)}.0`
  }
}

function interactorWithParsedTokens(resolution: LookupResolution, tokens: UMPToken[]): OverlayUMPTokenInteractor {
  const resolver = {
    queryDetailed: jest.fn(async () => resolution)
  } as unknown as LookupResolver
  const interactor = new OverlayUMPTokenInteractor(resolver)
  const parser = interactor as unknown as {
    parseLookupAnswers: () => UMPToken[]
  }
  jest.spyOn(parser, 'parseLookupAnswers').mockReturnValue(tokens)
  return interactor
}

describe('CWI account lookup diagnostics', () => {
  it('returns not-found when every host returned empty', async () => {
    const interactor = new OverlayUMPTokenInteractor(resolverWith(async () => ({ type: 'output-list', outputs: [] })))

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(1))).resolves.toBeUndefined()
  })

  it('returns not-found when one host is empty and another host fails', async () => {
    const interactor = new OverlayUMPTokenInteractor(
      resolverWith(async host => {
        if (host.includes('two')) throw new Error('overlay unavailable')
        return { type: 'output-list', outputs: [] }
      })
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(2))).resolves.toBeUndefined()
    await expect(interactor.findByRecoveryKeyHash(Array.from({ length: 32 }).fill(2))).resolves.toBeUndefined()
  })

  it('uses the same partial-empty rule when resolving an old token outpoint', async () => {
    const interactor = new OverlayUMPTokenInteractor(
      resolverWith(async host => {
        if (host.includes('two')) throw new Error('overlay unavailable')
        return { type: 'output-list', outputs: [] }
      })
    )
    const findByOutpoint = (
      interactor as unknown as {
        findByOutpoint: (outpoint: string) => Promise<{ beef: number[]; outputIndex: number } | undefined>
      }
    ).findByOutpoint.bind(interactor)

    await expect(findByOutpoint(`${'a'.repeat(64)}.0`)).resolves.toBeUndefined()
  })

  it('keeps an old token outpoint indeterminate when no host responds cleanly', async () => {
    const interactor = new OverlayUMPTokenInteractor(
      resolverWith(async () => {
        throw new Error('overlay unavailable')
      })
    )
    const findByOutpoint = (
      interactor as unknown as {
        findByOutpoint: (outpoint: string) => Promise<{ beef: number[]; outputIndex: number } | undefined>
      }
    ).findByOutpoint.bind(interactor)

    await expect(findByOutpoint(`${'a'.repeat(64)}.0`)).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      code: 'WERR_UMP_LOOKUP_INDETERMINATE',
      reason: 'lookup-incomplete',
      diagnostics: {
        hostCount: 2,
        successfulHosts: 0,
        emptyHosts: 0,
        failedHosts: 2,
        outputCount: 0
      }
    } satisfies Partial<UMPTokenLookupError>)
  })

  it('rejects lookup when every host fails', async () => {
    const interactor = new OverlayUMPTokenInteractor(
      resolverWith(async () => {
        throw new Error('overlay unavailable')
      })
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(2))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      code: 'WERR_UMP_LOOKUP_INDETERMINATE',
      reason: 'lookup-incomplete',
      diagnostics: {
        hostCount: 2,
        successfulHosts: 0,
        emptyHosts: 0,
        failedHosts: 2,
        outputCount: 0
      }
    } satisfies Partial<UMPTokenLookupError>)
  })

  it('uses one verified token despite empty, malformed, and failing peers', async () => {
    const token = tokenForPresentationHash(3)
    const interactor = interactorWithParsedTokens(
      resolutionWith(2, {
        hostCount: 3,
        successfulHosts: 2,
        emptyHosts: 1,
        failedHosts: 1
      }),
      [token]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(token)
  })

  it('returns not-found when malformed output is accompanied by a clean empty response', async () => {
    const interactor = interactorWithParsedTokens(
      resolutionWith(1, {
        hostCount: 2,
        successfulHosts: 2,
        emptyHosts: 1
      }),
      []
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBeUndefined()
  })

  it('returns not-found when a mismatched token is accompanied by a clean empty response', async () => {
    const interactor = interactorWithParsedTokens(
      resolutionWith(1, {
        hostCount: 2,
        successfulHosts: 2,
        emptyHosts: 1
      }),
      [tokenForPresentationHash(9)]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBeUndefined()
  })

  it('rejects malformed output when no host supplies a token or clean empty response', async () => {
    const interactor = interactorWithParsedTokens(resolutionWith(1), [])

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      reason: 'token-malformed'
    })
  })

  it('rejects more than one distinct verified token despite a clean empty response', async () => {
    const interactor = interactorWithParsedTokens(
      resolutionWith(2, {
        hostCount: 2,
        successfulHosts: 2,
        emptyHosts: 1
      }),
      [tokenForPresentationHash(3, 'a'), tokenForPresentationHash(3, 'b')]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      reason: 'token-ambiguous'
    })
  })

  it('keeps authentication unknown until lookup succeeds and rejects invalid initial state', async () => {
    const interactor: UMPTokenInteractor = {
      findByPresentationKeyHash: jest.fn(async () => undefined),
      findByRecoveryKeyHash: jest.fn(async () => undefined),
      buildAndSend: jest.fn(async () => `${'a'.repeat(64)}.0`)
    }
    const buildWallet = async (): Promise<WalletInterface> => Object.create(null) as WalletInterface
    const saveRecoveryKey = async (): Promise<true> => true
    const getPassword = async (): Promise<string> => 'password'

    const manager = new CWIStyleWalletManager('admin.example', buildWallet, interactor, saveRecoveryKey, getPassword)
    expect(manager.authenticationFlow).toBe('unknown')
    await expect(manager.providePassword('password')).rejects.toThrow('Determine account status')

    const withInvalidSnapshot = new CWIStyleWalletManager(
      'admin.example',
      buildWallet,
      interactor,
      saveRecoveryKey,
      getPassword,
      undefined,
      [1, 2, 3]
    )
    await expect(withInvalidSnapshot.ready).rejects.toThrow('Failed to load snapshot')
    expect(withInvalidSnapshot.authenticationFlow).toBe('unknown')
  })
})
