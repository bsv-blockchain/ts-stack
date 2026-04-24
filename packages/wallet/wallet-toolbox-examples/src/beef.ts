import {
  Beef,
  InternalizeActionArgs,
  PrivateKey,
  PublicKey,
  SignActionArgs
} from '@bsv/sdk'
import {
  randomBytesBase64,
  ScriptTemplateBRC29,
  Services,
  Setup,
  SetupWallet
} from '@bsv/wallet-toolbox'

/**
 * Example of internalizing a BRC29 wallet payment output into the receiving wallet.
 *
 * This example can be run by the following command:
 *
 * ```bash
 * npx tsx internalizeWalletPayment
 * ```
 *
 * Combine this with the [balances](./README.md#function-balances) example to observe satoshis being transfered between
 * two wallets.
 *
 * @publicbody
 */
export async function internalizeWalletPayment() {
  // obtain the secrets environment for the testnet network.
  const env = Setup.getEnv('main')

  const setup1 = await Setup.createWalletClient({ env })

  // setup2 will be the receiving wallet using the rootKey associated with identityKey2
  const setup2 = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[env.identityKey2]
  })

  const storage = await Setup.createStorageKnex({
    knex: Setup.createSQLiteKnex('getbeef.sqlite'),
    databaseName: 'getbeef',
    env
  })
  storage.setServices(new Services(env.chain))

  const txid =
    'e519f2e9a93477ad718cbea63528b458a0a056bdb462399e2ff094766bbc2a34'
  const beef = await storage.getBeefForTransaction(txid, {})

  const args: InternalizeActionArgs = {
    tx: beef.toBinaryAtomic(txid),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: '2ZrmJLsvhHQ=',
          derivationSuffix: 'rzlkGU80Z4I=',
          senderIdentityKey: setup2.identityKey
        }
      }
    ],
    description: 'from WUI export'
  }
  const iwpr = await setup1.wallet.internalizeAction(args)
  console.log(JSON.stringify(iwpr))
}

internalizeWalletPayment().catch(console.error)
