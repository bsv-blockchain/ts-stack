import { Wallet } from '../../out/src'
import { sweepWalletWithEvidence } from '../../examples/sweep'

interface MutableBalances {
  source: number
  target: number
}

function walletPair(
  balances: MutableBalances,
  overrides: {
    sourceChain?: 'main' | 'test'
    sourceIdentity?: string
    targetChain?: 'main' | 'test'
    targetIdentity?: string
  } = {}
): { source: Wallet; target: Wallet; sweepTo: jest.Mock } {
  const sweepTo = jest.fn(async () => {
    balances.target += balances.source
    balances.source = 0
  })
  const source = {
    chain: overrides.sourceChain ?? 'test',
    identityKey: overrides.sourceIdentity ?? `02${'11'.repeat(32)}`,
    balance: async () => balances.source,
    sweepTo
  } as unknown as Wallet
  const target = {
    chain: overrides.targetChain ?? 'test',
    identityKey: overrides.targetIdentity ?? `03${'22'.repeat(32)}`,
    balance: async () => balances.target
  } as unknown as Wallet
  return { source, target, sweepTo }
}

describe('wallet sweep example', () => {
  test('records exact before and after evidence', async () => {
    const balances = { source: 12, target: 30 }
    const { source, target, sweepTo } = walletPair(balances)

    await expect(sweepWalletWithEvidence(source, target)).resolves.toMatchObject({
      sourceBefore: 12,
      sourceAfter: 0,
      targetBefore: 30,
      targetAfter: 42,
      sourceIdentityKey: source.identityKey,
      targetIdentityKey: target.identityKey
    })
    expect(sweepTo).toHaveBeenCalledWith(target)
  })

  test('rejects cross-chain and same-identity sweeps before mutation', async () => {
    const crossChain = walletPair({ source: 1, target: 0 }, { targetChain: 'main' })
    await expect(sweepWalletWithEvidence(crossChain.source, crossChain.target)).rejects.toThrow('same chain')
    expect(crossChain.sweepTo).not.toHaveBeenCalled()

    const identity = `02${'33'.repeat(32)}`
    const sameIdentity = walletPair({ source: 1, target: 0 }, { sourceIdentity: identity, targetIdentity: identity })
    await expect(sweepWalletWithEvidence(sameIdentity.source, sameIdentity.target)).rejects.toThrow(
      'different identities'
    )
    expect(sameIdentity.sweepTo).not.toHaveBeenCalled()
  })
})
