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

describe('CWI account lookup diagnostics', () => {
  it('returns not-found only when every host authoritatively returned empty', async () => {
    const interactor = new OverlayUMPTokenInteractor(resolverWith(async () => ({ type: 'output-list', outputs: [] })))

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(1))).resolves.toBeUndefined()
  })

  it('does not classify an availability failure as a new account', async () => {
    const interactor = new OverlayUMPTokenInteractor(
      resolverWith(async host => {
        if (host.includes('two')) throw new Error('overlay unavailable')
        return { type: 'output-list', outputs: [] }
      })
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(2))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      code: 'WERR_UMP_LOOKUP_INDETERMINATE',
      reason: 'lookup-incomplete',
      diagnostics: {
        hostCount: 2,
        successfulHosts: 1,
        emptyHosts: 1,
        failedHosts: 1,
        outputCount: 0
      }
    } satisfies Partial<UMPTokenLookupError>)
  })

  it('rejects a UMP token that is not bound to the queried presentation hash', async () => {
    const resolution: LookupResolution = {
      answer: {
        type: 'output-list',
        outputs: [{ beef: [1], outputIndex: 0 }]
      },
      progress: {
        type: 'output-list',
        outputs: [{ beef: [1], outputIndex: 0 }],
        txIds: ['a'.repeat(64)],
        isFinal: true,
        hostCount: 1,
        completedHosts: 1,
        successfulHosts: 1,
        emptyHosts: 0,
        failedHosts: 0,
        rejectedHosts: 0,
        freeformHosts: 0
      }
    }
    const resolver = {
      queryDetailed: jest.fn(async () => resolution)
    } as unknown as LookupResolver
    const interactor = new OverlayUMPTokenInteractor(resolver)
    const fields = Array.from({ length: 11 }, () => Array.from({ length: 32 }).fill(1))
    const mismatchedToken: UMPToken = {
      passwordSalt: fields[0],
      passwordPresentationPrimary: fields[1],
      passwordRecoveryPrimary: fields[2],
      presentationRecoveryPrimary: fields[3],
      passwordPrimaryPrivileged: fields[4],
      presentationRecoveryPrivileged: fields[5],
      presentationHash: Array.from({ length: 32 }).fill(9),
      recoveryHash: fields[7],
      presentationKeyEncrypted: fields[8],
      passwordKeyEncrypted: fields[9],
      recoveryKeyEncrypted: fields[10],
      currentOutpoint: `${'a'.repeat(64)}.0`
    }
    const parser = interactor as unknown as {
      parseLookupAnswers: () => UMPToken[]
    }
    jest.spyOn(parser, 'parseLookupAnswers').mockReturnValue([mismatchedToken])

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      reason: 'token-malformed'
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
