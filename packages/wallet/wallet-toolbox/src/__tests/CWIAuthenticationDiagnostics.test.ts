import {
  LookupResolver,
  LookupResolution,
  LockingScript,
  PrivateKey,
  Transaction,
  UnlockingScript,
  WalletInterface
} from '@bsv/sdk'
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

function tokenAtOutpoint(hashByte: number, outpoint: string): UMPToken {
  return { ...tokenForPresentationHash(hashByte), currentOutpoint: outpoint }
}

function chainedTx(sourceTransaction?: Transaction): Transaction {
  const tx = new Transaction()
  tx.addInput({
    ...(sourceTransaction != null ? { sourceTransaction } : { sourceTXID: '00'.repeat(32) }),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript([]),
    sequence: 0xffffffff
  })
  tx.addOutput({ satoshis: 1, lockingScript: new LockingScript([]) })
  return tx
}

function umpTokenLockingScript(
  hashByte: number,
  opts: { recoveryByte?: number; fieldCount?: number; presentationLength?: number; recoveryLength?: number } = {}
): LockingScript {
  const { recoveryByte = 1, fieldCount = 11, presentationLength = 32, recoveryLength = 32 } = opts
  const pubkey = new PrivateKey(42).toPublicKey().encode(true) as number[]
  const fields = Array.from({ length: fieldCount }, (_, i) => {
    if (i === 6) return Array.from({ length: presentationLength }).fill(hashByte) as number[]
    if (i === 7) return Array.from({ length: recoveryLength }).fill(recoveryByte) as number[]
    return Array.from({ length: 32 }).fill(1) as number[]
  })
  return new LockingScript([
    { op: pubkey.length, data: pubkey },
    { op: 172 }, // OP_CHECKSIG
    ...fields.map(f => ({ op: f.length, data: f }))
  ])
}

function withoutSourceTransactions(tx: Transaction): Transaction {
  return Transaction.fromBinary(tx.toBinary())
}

function resolutionWithBeefs(beefs: number[][], progress: Partial<LookupResolution['progress']> = {}): LookupResolution {
  const base = resolutionWith(beefs.length, progress)
  base.answer.outputs = beefs.map(beef => ({ beef, outputIndex: 0 }))
  return base
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
    await expect(interactor.findByRecoveryKeyHash(Array.from({ length: 32 }).fill(1))).resolves.toBe(token)
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

  it('returns the newest rendition when a competing token is a spent predecessor', async () => {
    const oldTx = chainedTx()
    const newTx = chainedTx(oldTx)
    const unrelatedTx = chainedTx()
    unrelatedTx.addOutput({ satoshis: 2, lockingScript: new LockingScript([]) })
    const oldToken = tokenAtOutpoint(3, `${oldTx.id('hex')}.0`)
    const newToken = tokenAtOutpoint(3, `${newTx.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([oldTx.toBEEF(true), newTx.toBEEF(true), unrelatedTx.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [oldToken, newToken]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(newToken)
  })

  it('resolves a multi-hop rendition chain to its tip', async () => {
    const first = chainedTx()
    const second = chainedTx(first)
    const third = chainedTx(second)
    const tokens = [first, second, third].map(tx => tokenAtOutpoint(3, `${tx.id('hex')}.0`))
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs(
        [first, second, third].map(tx => tx.toBEEF(true)),
        { hostCount: 2, successfulHosts: 2 }
      ),
      tokens
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(tokens[2])
  })

  it('detects supersession through an intermediate rendition absent from the lookup answer', async () => {
    const first = chainedTx()
    const second = chainedTx(first)
    const third = chainedTx(second)
    const firstToken = tokenAtOutpoint(3, `${first.id('hex')}.0`)
    const thirdToken = tokenAtOutpoint(3, `${third.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([first.toBEEF(true), third.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [firstToken, thirdToken]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(thirdToken)
  })

  it('still rejects competing tokens with no supersession relationship', async () => {
    const forkA = chainedTx()
    const forkB = chainedTx()
    forkB.addOutput({ satoshis: 2, lockingScript: new LockingScript([]) })
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([forkA.toBEEF(true), forkB.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [tokenAtOutpoint(3, `${forkA.id('hex')}.0`), tokenAtOutpoint(3, `${forkB.id('hex')}.0`)]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      reason: 'token-ambiguous'
    })
  })

  it('prefers the proven continuation over an independently minted forked token', async () => {
    const predecessor = chainedTx()
    predecessor.outputs[0].lockingScript = umpTokenLockingScript(3)
    const continuation = chainedTx(predecessor)
    const freshMint = chainedTx()
    freshMint.addOutput({ satoshis: 2, lockingScript: new LockingScript([]) })
    const continuationToken = tokenAtOutpoint(3, `${continuation.id('hex')}.0`)
    const freshMintToken = tokenAtOutpoint(3, `${freshMint.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([freshMint.toBEEF(true), continuation.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [freshMintToken, continuationToken]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(
      continuationToken
    )
  })

  it('resolves regardless of the order in which hosts returned the tokens', async () => {
    const oldTx = chainedTx()
    const newTx = chainedTx(oldTx)
    const oldToken = tokenAtOutpoint(3, `${oldTx.id('hex')}.0`)
    const newToken = tokenAtOutpoint(3, `${newTx.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([newTx.toBEEF(true), oldTx.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [newToken, oldToken]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(newToken)
  })

  it('treats duplicate records of the same outpoint as one token, not a conflict', async () => {
    const tx = chainedTx()
    const first = tokenAtOutpoint(3, `${tx.id('hex')}.0`)
    const second = tokenAtOutpoint(3, `${tx.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([tx.toBEEF(true)], { hostCount: 2, successfulHosts: 2 }),
      [first, second]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(second)
  })

  it('stays indeterminate when a competing token lacks an outpoint', async () => {
    const tx = chainedTx()
    const anonymous: UMPToken = { ...tokenForPresentationHash(3), currentOutpoint: undefined }
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([tx.toBEEF(true)], { hostCount: 2, successfulHosts: 2 }),
      [tokenAtOutpoint(3, `${tx.id('hex')}.0`), anonymous]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      reason: 'token-ambiguous'
    })
  })

  it('refuses to pick a winner when a competing token has no examinable evidence', async () => {
    const predecessor = chainedTx()
    predecessor.outputs[0].lockingScript = umpTokenLockingScript(3)
    const continuation = chainedTx(predecessor)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([continuation.toBEEF(true), [1, 2, 3]], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [tokenAtOutpoint(3, `${continuation.id('hex')}.0`), tokenAtOutpoint(3, 'b'.repeat(64) + '.0')]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      reason: 'token-ambiguous'
    })
  })

  it('stays indeterminate when both forked tokens prove same-identity continuation', async () => {
    const predecessorA = chainedTx()
    predecessorA.outputs[0].lockingScript = umpTokenLockingScript(3)
    const predecessorB = chainedTx()
    predecessorB.outputs[0].lockingScript = umpTokenLockingScript(3)
    predecessorB.addOutput({ satoshis: 2, lockingScript: new LockingScript([]) })
    const continuationA = chainedTx(predecessorA)
    const continuationB = chainedTx(predecessorB)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([continuationA.toBEEF(true), continuationB.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [tokenAtOutpoint(3, `${continuationA.id('hex')}.0`), tokenAtOutpoint(3, `${continuationB.id('hex')}.0`)]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      reason: 'token-ambiguous'
    })
  })

  it('recognizes continuation through the recovery hash when the presentation key rotated', async () => {
    const predecessor = chainedTx()
    predecessor.outputs[0].lockingScript = umpTokenLockingScript(9, { recoveryByte: 1 })
    const continuation = chainedTx(predecessor)
    const freshMint = chainedTx()
    freshMint.addOutput({ satoshis: 2, lockingScript: new LockingScript([]) })
    const continuationToken = tokenAtOutpoint(3, `${continuation.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([continuation.toBEEF(true), freshMint.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [continuationToken, tokenAtOutpoint(3, `${freshMint.id('hex')}.0`)]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(
      continuationToken
    )
  })

  it('ignores a predecessor with malformed identity hashes', async () => {
    const predecessor = chainedTx()
    predecessor.outputs[0].lockingScript = umpTokenLockingScript(3, {
      presentationLength: 31,
      recoveryLength: 31
    })
    const continuation = chainedTx(predecessor)
    const freshMint = chainedTx()
    freshMint.addOutput({ satoshis: 2, lockingScript: new LockingScript([]) })
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([continuation.toBEEF(true), freshMint.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [tokenAtOutpoint(3, `${continuation.id('hex')}.0`), tokenAtOutpoint(3, `${freshMint.id('hex')}.0`)]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      reason: 'token-ambiguous'
    })
  })

  it('ignores a predecessor whose locking script cannot be decoded', async () => {
    const malformedPredecessor = chainedTx()
    const continuation = chainedTx(malformedPredecessor)
    const freshMint = chainedTx()
    freshMint.addOutput({ satoshis: 2, lockingScript: new LockingScript([]) })
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([continuation.toBEEF(true), freshMint.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [tokenAtOutpoint(3, `${continuation.id('hex')}.0`), tokenAtOutpoint(3, `${freshMint.id('hex')}.0`)]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).rejects.toMatchObject({
      name: 'UMPTokenLookupError',
      reason: 'token-ambiguous'
    })
  })

  it('recognizes a twelve-field predecessor token (profiles present)', async () => {
    const predecessor = chainedTx()
    predecessor.outputs[0].lockingScript = umpTokenLockingScript(3, { fieldCount: 12 })
    const continuation = chainedTx(predecessor)
    const freshMint = chainedTx()
    freshMint.addOutput({ satoshis: 2, lockingScript: new LockingScript([]) })
    const continuationToken = tokenAtOutpoint(3, `${continuation.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([continuation.toBEEF(true), freshMint.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [continuationToken, tokenAtOutpoint(3, `${freshMint.id('hex')}.0`)]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(
      continuationToken
    )
  })

  it('picks the continuation among a stale predecessor, its update, and an unrelated fork', async () => {
    const stale = chainedTx()
    stale.outputs[0].lockingScript = umpTokenLockingScript(3)
    const continuation = chainedTx(stale)
    const unrelatedFork = chainedTx()
    unrelatedFork.addOutput({ satoshis: 2, lockingScript: new LockingScript([]) })
    const continuationToken = tokenAtOutpoint(3, `${continuation.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([stale.toBEEF(true), continuation.toBEEF(true), unrelatedFork.toBEEF(true)], {
        hostCount: 3,
        successfulHosts: 3
      }),
      [
        tokenAtOutpoint(3, `${stale.id('hex')}.0`),
        continuationToken,
        tokenAtOutpoint(3, `${unrelatedFork.id('hex')}.0`)
      ]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(
      continuationToken
    )
  })

  it('merges evidence when hosts serve the same token at different BEEF depths', async () => {
    const predecessor = chainedTx()
    const intermediate = chainedTx(predecessor)
    const tip = chainedTx(intermediate)
    const shallowTip = withoutSourceTransactions(tip)
    const predecessorToken = tokenAtOutpoint(3, `${predecessor.id('hex')}.0`)
    const tipToken = tokenAtOutpoint(3, `${tip.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([shallowTip.toBEEF(true), predecessor.toBEEF(true), tip.toBEEF(true)], {
        hostCount: 3,
        successfulHosts: 3
      }),
      [tipToken, predecessorToken]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(tipToken)
  })

  it('resolves a very deep update chain without exhausting the stack', async () => {
    let tip = chainedTx()
    const root = tip
    for (let i = 0; i < 1200; i++) tip = chainedTx(tip)
    const rootToken = tokenAtOutpoint(3, `${root.id('hex')}.0`)
    const tipToken = tokenAtOutpoint(3, `${tip.id('hex')}.0`)
    const interactor = interactorWithParsedTokens(
      resolutionWithBeefs([root.toBEEF(true), tip.toBEEF(true)], {
        hostCount: 2,
        successfulHosts: 2
      }),
      [rootToken, tipToken]
    )

    await expect(interactor.findByPresentationKeyHash(Array.from({ length: 32 }).fill(3))).resolves.toBe(tipToken)
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
