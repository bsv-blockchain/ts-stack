import { canonicalOutputJSON, decodeOutputBytes, P2PKH, Transaction, type OutputWalletFundingOperation } from '@bsv/sdk'
import type { Wallet } from '../../Wallet'
import { parseFundingRecoveryOperation, requireFunding, type FundingRecoveryResult } from '../../storage/fundingRecovery/FundingRecoveryProtocol'
import { SQLiteFundingRecoveryStore } from '../../storage/fundingRecovery/SQLiteFundingRecoveryStore'
import { internalizeAction as signInternalize } from '../methods/internalizeAction'
import { internalizeAction as storeInternalize } from '../../storage/methods/internalizeAction'

/**
 * Explicit local custody capability above BRC-100. The installed application must
 * authenticate and authorize the acquisition and its acceptance policy first.
 * Accepted means the wallet credited this exact output atomically with a receipt;
 * broadcast/mining and protected delivery are separate obligations.
 */
export class RecoverableFundingController {
  constructor(private readonly wallet: Wallet, private readonly store: SQLiteFundingRecoveryStore) {}

  async internalizeOnce(input: OutputWalletFundingOperation): Promise<FundingRecoveryResult> {
    const operation = parseFundingRecoveryOperation(input)
    return await this.withWallet(async userId => {
      requireFunding(operation.seller === this.wallet.identityKey && canonicalOutputJSON(operation.funding.chain) === canonicalOutputJSON(this.store.chain), 'Funding operation seller or selected chain differs')
      const retained = await this.store.retain(userId, this.wallet.identityKey, operation)
      const prior = await this.store.getInternalization(userId, this.wallet.identityKey, operation.id)
      if (prior.state === 'accepted' || prior.state === 'rejected') return prior
      const tx = Transaction.fromAtomicBEEF(decodeOutputBytes(operation.beef, 65536))
      const expected = new P2PKH().lock(this.wallet.keyDeriver.derivePrivateKey([2, '3241645161d8'], `${operation.derivationPrefix} ${operation.derivationSuffix}`, operation.buyer).toAddress()).toHex()
      const matches = tx.outputs.flatMap((output, index) => output.lockingScript.toHex() === expected ? [index] : [])
      if (matches.length !== 1 || matches[0] !== operation.funding.outputIndex) {
        await retained.reject()
        return await this.store.getInternalization(userId, this.wallet.identityKey, operation.id)
      }
      // BEEF graph/root validity alone does not execute unmined Script ancestors.
      requireFunding(await tx.verify(await this.wallet.getServices().getChainTracker()), 'Funding transaction did not pass Script and SPV verification')
      const auth = await this.wallet.storage.getAuth(true)
      requireFunding(auth.userId === userId, 'Funding recovery wallet authorization changed')
      await signInternalize(this.wallet, auth, {
        tx: decodeOutputBytes(operation.beef, 65536),
        outputs: [{ outputIndex: operation.funding.outputIndex, protocol: 'wallet payment', paymentRemittance: { derivationPrefix: operation.derivationPrefix, derivationSuffix: operation.derivationSuffix, senderIdentityKey: operation.buyer } }],
        description: 'Recoverable acquisition funding'
      }, async args => await storeInternalize(this.store.storage, auth, args, retained))
      const result = await this.store.getInternalization(userId, this.wallet.identityKey, operation.id)
      requireFunding(result.state === 'accepted', 'Funding recovery ownership has not committed')
      return result
    })
  }

  /** Durable lookup only. An unavailable database throws; absence is never guessed. */
  async getInternalization(id: string): Promise<FundingRecoveryResult> {
    return await this.withWallet(async userId => await this.store.getInternalization(userId, this.wallet.identityKey, id))
  }

  private async withWallet<T>(run: (userId: number) => Promise<T>): Promise<T> {
    return await this.wallet.storage.runAsStorageProvider(async active => {
      requireFunding(active === this.store.storage && active.getSettings().chain === this.wallet.chain, 'Funding recovery storage is not the active wallet provider')
      requireFunding(!this.wallet.actionBatch.hasWorkspace, 'Funding recovery requires a committed wallet workspace')
      const auth = await this.wallet.storage.getAuth(true)
      return await run(auth.userId!)
    })
  }
}
