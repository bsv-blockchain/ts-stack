import { Wallet } from '../out/src/index.js'

export interface SweepEvidence {
  sourceAfter: number
  sourceBefore: number
  sourceIdentityKey: string
  targetAfter: number
  targetBefore: number
  targetIdentityKey: string
}

/**
 * Transfer the source wallet's available balance to a second, already
 * configured wallet. Callers are responsible for selecting the intended
 * chain, identities, storage providers, and credentials before invoking this
 * example.
 */
export async function sweepWallet(source: Wallet, target: Wallet): Promise<void> {
  await source.sweepTo(target)
}

/**
 * Run a sweep and return observable balance evidence for operator review.
 */
export async function sweepWalletWithEvidence(source: Wallet, target: Wallet): Promise<SweepEvidence> {
  if (source.chain !== target.chain) {
    throw new Error('Source and target wallets must use the same chain')
  }
  if (source.identityKey === target.identityKey) {
    throw new Error('Source and target wallets must use different identities')
  }

  const [sourceBefore, targetBefore] = await Promise.all([source.balance(), target.balance()])
  await sweepWallet(source, target)
  const [sourceAfter, targetAfter] = await Promise.all([source.balance(), target.balance()])

  return {
    sourceIdentityKey: source.identityKey,
    targetIdentityKey: target.identityKey,
    sourceBefore,
    targetBefore,
    sourceAfter,
    targetAfter
  }
}
