import { Beef, LockingScript, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils, outputPacketDigest, type OutputWalletFundingOperation } from '@bsv/sdk'
import type { TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { genesisHeader } from '../../../services/chaintracker/chaintracks/util/blockHeaderUtilities'

/** Public synthetic inclusion fixture; it is never a claim of real-chain funding. */
export function fundingFixture(context: TestWalletNoSetup, acquisitionId = 'a1'.repeat(32)) {
  const buyer = new PrivateKey(81).toPublicKey().toString()
  const derivationPrefix = 'cHVibGljLWZpeHR1cmU=', derivationSuffix = 'cGF5bWVudA=='
  const paymentKey = context.keyDeriver.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, buyer)
  const source = new Transaction(1, [], [{ satoshis: 1000, lockingScript: LockingScript.fromHex('51') }], 0)
  source.merklePath = new MerklePath(1234, [[{ offset: 0, hash: source.id('hex'), txid: true }]])
  const tx = new Transaction(1, [{ sourceTXID: source.id('hex'), sourceTransaction: source, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: UnlockingScript.fromHex('') }], [
    { satoshis: 900, lockingScript: LockingScript.fromHex('51') },
    { satoshis: 100, lockingScript: new P2PKH().lock(paymentKey.toAddress()) }
  ], 0)
  const chain = { network: context.chain, genesisHash: genesisHeader(context.chain).hash }
  const tracker = { currentHeight: async () => 1400, isValidRootForHeight: async (root: string, height: number) => root === source.id('hex') && height === 1234 }
  function operation(transaction = tx): OutputWalletFundingOperation {
    const beef = new Beef()
    beef.mergeTransaction(transaction)
    const funding = { chain, txid: transaction.id('hex'), outputIndex: 1 }
    return { id: outputPacketDigest('wallet-funding', { seller: context.identityKey, acquisitionId, funding }), acquisitionId, funding, buyer, seller: context.identityKey, satoshis: '100', derivationPrefix, derivationSuffix, beef: Utils.toBase64(beef.toBinaryAtomic(transaction.id('hex'))) }
  }
  return { source, tx, chain, tracker, operation }
}
