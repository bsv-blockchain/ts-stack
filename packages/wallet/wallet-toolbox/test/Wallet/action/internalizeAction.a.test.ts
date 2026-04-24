import { Beef, InternalizeOutput } from '@bsv/sdk'
import { sdk, StorageKnex } from '../../../src/index.all'
import { _tu, expectToThrowWERR, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import { getBeefForTransaction } from '../../../src/storage/methods/getBeefForTransaction'

/**
 * NOT PASSING YET
 */
describe.skip('internalizeAction tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnvFlags('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('internalizeActionTests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('internalizeActionTests'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  // Check:  'unproven' or 'completed' status. Any other status is an error.
  // When the transaction already exists, the description is updated. The isOutgoing sense is not changed.

  test.skip('1_default real wallet data', async () => {
    // 1. construct a normal transaction with user supplied output.
    // 2. dito but user input
    // 3..Repeat 1 & 2  but use sign action
    // Repeat 1-3 but use noSend and then a sendWith.
    // Figure the exact fee cost for transactions 1-3 and start with a noSend transaction that creates a change output with just the right fee amount. Then rebuild 1-3, as second tx, feed it the noSend change from the first tx, confirm no additional change is added or produced, use sendWith to send both as a batch.
    // "basket insertion" Merge Rules:
    // The "default" basket may not be specified as the insertion basket.
    // A change output in the "default" basket may not be target of an insertion into a different basket.
    // These baskets do not affect the wallet's balance and are typed "custom".
    // "wallet payment" Merge Rules:
    // Targetting an existing change "default" basket output results in a no-op. No error. No alterations made.
    // Targetting a previously "custom" non-change output converts it into a change output. This alters the transaction's amount, and the wallet balance.

    for (const { wallet, activeStorage: storage } of ctxs) {
      try {
        // Prepare StorageGetBeefOptions
        const options: sdk.StorageGetBeefOptions = {
          // Setting 'known' tells it not to include rawTxs it already knows about, just their txids.
          // trustSelf: 'known',
          // Setting knownTxids tells it not to include these rawTxs, just their txids.
          // knownTxids: ['2795b293c698b2244147aaba745db887a632d21990c474df46d842ec3e52f122'],
          // False and undefined are equal here so no need for this.
          // ignoreStorage: false,
          // Yes, you expect storage to have the info, so don't use services.
          ignoreServices: true
          // Since you aren't using services and there won't be any newProven (rawTx's with merklePaths previously unknown to storage but required for this beef)
          // ignoreNewProven: false,
          // You don't expect infinitely deep nonsense
          // minProofLevel: 0
        }

        // Fetch Beef object
        const beef = await storage.getBeefForTransaction(
          '2795b293c698b2244147aaba745db887a632d21990c474df46d842ec3e52f122',
          options
        )

        //console.log('Beef Object:\n', beef.toLogString())

        // Ensure Beef object contains valid transactions
        if (beef.txs.length === 0) {
          throw new Error('Beef contains no transactions')
        }

        // Validate the first transaction in the Beef object
        const firstTx = beef.txs[0]
        if (!firstTx.isValid) {
          console.error('First transaction is invalid:', firstTx)
          throw new Error('Beef contains an invalid transaction')
        }

        expect(beef.atomicTxid).toBeUndefined()

        // Convert to AtomicBEEF transaction
        const atomicTx = beef.toBinaryAtomic('2795b293c698b2244147aaba745db887a632d21990c474df46d842ec3e52f122')
        //console.log('Atomic Transaction:', atomicTx)

        // {
        //   const abeef = Beef.fromBinary(atomicTx)
        //   expect(abeef.atomicTxid).toBe('2795b293c698b2244147aaba745db887a632d21990c474df46d842ec3e52f122')
        // }

        // This needs to be a real output (the locking script and derivation bits / key need to work with each other)
        // But it is still a valid test to see what the reaction is to this nonsense :-)
        // Prepare output for internalization
        const output: InternalizeOutput = {
          outputIndex: 2,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: 'y0tgyMJbVWKhds2/MWkDBA==',
            derivationSuffix: 'J1Q1E8re2RbvKONkEiEHDA==',
            senderIdentityKey: '03ac2d10bdb0023f4145cc2eba2fcd2ad3070cb2107b0b48170c46a9440e4cc3fe'
          }
        }

        // Internalize Action
        const r = await wallet.internalizeAction({
          tx: atomicTx,
          outputs: [output],
          description: 'Default wallet payment'
        })

        // Validate result
        //console.log('Internalize Action Result:', r)
        expect(r).toBeDefined()
      } catch (error) {
        console.error('Test failed with error:', error)
        throw error
      }
    }
  })

  test('2_default real basket insertion', async () => {
    // 1. construct a normal transaction with user supplied output.
    // 2. dito but user input
    // 3..Repeat 1 & 2  but use sign action
    // Repeat 1-3 but use noSend and then a sendWith.
    // Figure the exact fee cost for transactions 1-3 and start with a noSend transaction that creates a change output with just the right fee amount. Then rebuild 1-3, as second tx, feed it the noSend change from the first tx, confirm no additional change is added or produced, use sendWith to send both as a batch.
    // "basket insertion" Merge Rules:
    // The "default" basket may not be specified as the insertion basket.
    // A change output in the "default" basket may not be target of an insertion into a different basket.
    // These baskets do not affect the wallet's balance and are typed "custom".
    // "wallet payment" Merge Rules:
    // Targetting an existing change "default" basket output results in a no-op. No error. No alterations made.
    // Targetting a previously "custom" non-change output converts it into a change output. This alters the transaction's amount, and the wallet balance.

    for (const { wallet, activeStorage: storage } of ctxs) {
      try {
        // Prepare StorageGetBeefOptions
        const options: sdk.StorageGetBeefOptions = {
          // Setting 'known' tells it not to include rawTxs it already knows about, just their txids.
          // trustSelf: 'known',
          // Setting knownTxids tells it not to include these rawTxs, just their txids.
          // knownTxids: ['2795b293c698b2244147aaba745db887a632d21990c474df46d842ec3e52f122'],
          // False and undefined are equal here so no need for this.
          // ignoreStorage: false,
          // Yes, you expect storage to have the info, so don't use services.
          ignoreServices: true
          // Since you aren't using services and there won't be any newProven (rawTx's with merklePaths previously unknown to storage but required for this beef)
          // ignoreNewProven: false,
          // You don't expect infinitely deep nonsense
          // minProofLevel: 0
        }

        // Fetch Beef object
        const beef = await storage.getBeefForTransaction(
          'a3b2f0935c7b5bb7a841a09e535c13be86f4df0e7a91cebdc33812bfcc0eb9d7',
          options
        )

        //console.log('Beef Object:\n', beef.toLogString())

        // Ensure Beef object contains valid transactions
        if (beef.txs.length === 0) {
          throw new Error('Beef contains no transactions')
        }

        // Validate the first transaction in the Beef object
        const firstTx = beef.txs[0]
        if (!firstTx.isValid) {
          console.error('First transaction is invalid:', firstTx)
          throw new Error('Beef contains an invalid transaction')
        }

        expect(beef.atomicTxid).toBeUndefined()

        // Convert to AtomicBEEF transaction
        const atomicTx = beef.toBinaryAtomic('a3b2f0935c7b5bb7a841a09e535c13be86f4df0e7a91cebdc33812bfcc0eb9d7')
        //console.log('Atomic Transaction:', atomicTx)

        {
          const abeef = Beef.fromBinary(atomicTx)
          expect(abeef.atomicTxid).toBe('a3b2f0935c7b5bb7a841a09e535c13be86f4df0e7a91cebdc33812bfcc0eb9d7')
        }

        // This needs to be a real output (the locking script and derivation bits / key need to work with each other)
        // But it is still a valid test to see what the reaction is to this nonsense :-)
        // Prepare output for internalization
        const output: InternalizeOutput = {
          outputIndex: 0,
          protocol: 'basket insertion',
          // export interface BasketInsertion {
          //   basket: BasketStringUnder300Bytes
          //   customInstructions?: string
          //   tags?: OutputTagStringUnder300Bytes[]
          // }
          insertionRemittance: {
            basket: 'babbage-token-access',
            tags: [
              'babbage_originator todo.babbage.systems',
              'babbage_action_originator projectbabbage.com',
              'babbage_protocolname todo list',
              'babbage_protocolsecuritylevel 2',
              'babbage_counterparty self'
            ]
          }
        }

        // Internalize Action
        const r = await wallet.internalizeAction({
          tx: atomicTx,
          outputs: [output],
          description: 'Default basket insertion'
        })

        // Validate result
        //console.log('Internalize Action Result:', r)
        expect(r).toBeDefined()
      } catch (error) {
        console.error('Test failed with error:', error)
        throw error
      }
    }
  })

  test.skip('3_default', async () => {
    for (const { wallet, activeStorage: storage } of ctxs) {
      try {
        // Prepare StorageGetBeefOptions
        const options: sdk.StorageGetBeefOptions = {
          ignoreServices: true
        }

        // Fetch Beef object
        const beef = await storage.getBeefForTransaction(
          '2795b293c698b2244147aaba745db887a632d21990c474df46d842ec3e52f122',
          options
        )

        //console.log('Beef Object:', beef)

        // Ensure Beef object contains valid transactions
        if (beef.txs.length === 0) {
          throw new Error('Beef contains no transactions')
        }

        // Validate the first transaction in the Beef object
        const firstTx = beef.txs[0]
        if (!firstTx.isValid) {
          console.error('First transaction is invalid:', firstTx)
          throw new Error('Beef contains an invalid transaction')
        }

        expect(beef.atomicTxid).toBeDefined()

        // Convert to AtomicBEEF transaction
        const atomicTx = beef.toBinaryAtomic('2795b293c698b2244147aaba745db887a632d21990c474df46d842ec3e52f122')
        //console.log('Atomic Transaction:', atomicTx)

        // Prepare output for internalization
        const output: InternalizeOutput = {
          outputIndex: 2,
          protocol: 'basket insertion',
          paymentRemittance: {
            derivationPrefix: 'y0tgyMJbVWKhds2/MWkDBA==',
            derivationSuffix: 'J1Q1E8re2RbvKONkEiEHDA==',
            senderIdentityKey: '03ac2d10bdb0023f4145cc2eba2fcd2ad3070cb2107b0b48170c46a9440e4cc3fe'
          }
        }

        // Internalize Action
        const r = await wallet.internalizeAction({
          tx: atomicTx,
          outputs: [output],
          description: 'Default test description'
        })

        // Validate result
        //console.log('Internalize Action Result:', r)
        expect(r).toBeDefined()
      } catch (error) {
        console.error('Test failed with error:', error)
        throw error
      }
    }
  })
})
