#!/usr/bin/env node

import { randomBytes } from 'crypto'
import chalk from 'chalk'
import { createInterface } from 'readline';
import { WalletClient, PrivateKey, PublicKey, P2PKH, KeyDeriver, WalletInterface, InternalizeActionArgs } from '@bsv/sdk'
import { Wallet, WalletStorageManager, WalletSigner, Services, StorageClient, WalletPermissionsManager } from '@bsv/wallet-toolbox'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

async function makeWallet (
  chain: 'test' | 'main',
  storageURL: string,
  privateKey: string
): Promise<WalletInterface> {
  const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, 'hex'))
  const storageManager = new WalletStorageManager(keyDeriver.identityKey)
  const signer = new WalletSigner(chain, keyDeriver, storageManager)
  const services = new Services(chain)
  const wallet = new Wallet(signer, services)
  const client = new StorageClient(
    wallet,
    storageURL
  )
  await client.makeAvailable()
  await storageManager.addWalletStorageProvider(client)

  const { totalOutputs } = await wallet.listOutputs({ basket: '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8' }, 'admin.com')

  console.log(chalk.green(`💰 Wallet balance: ${totalOutputs}`))

  return wallet
}

async function fundWallet (
  network: 'test' | 'main',
  storageURL: string,
  amount: number,
  walletPrivateKey: string,
): Promise<void> {

  const wallet = await makeWallet(network, storageURL, walletPrivateKey)
  if (amount === 0) return
  const remote = await wallet.isAuthenticated({})
  console.log({ remote })

  const localWallet = new WalletClient('secure-json-api', 'deggen.com')
  const local = await localWallet.isAuthenticated({})
  console.log({ local })
  try {
    const { version } = await localWallet.getVersion()
    console.log(chalk.blue(`💰 Using local wallet version: ${version}`))
  } catch (err) {
    console.error(
      chalk.red('❌ Metanet Desktop is not installed or not running.')
    )
    console.log(
      chalk.blue('👉 Download Metanet Desktop: https://metanet.bsvb.tech')
    )
    process.exit(1)
  }
  const derivationPrefix = randomBytes(10).toString('base64')
  const derivationSuffix = randomBytes(10).toString('base64')
  const { publicKey: payer } = await localWallet.getPublicKey({
    identityKey: true
  })
  const payee = new PrivateKey(walletPrivateKey, 'hex').toPublicKey().toString()
  const { publicKey: derivedPublicKey } = await localWallet.getPublicKey({
    counterparty: payee,
    protocolID: [2, '3241645161d8'],
    keyID: `${derivationPrefix} ${derivationSuffix}`
  })
  const lockingScript = new P2PKH()
    .lock(PublicKey.fromString(derivedPublicKey).toAddress())
    .toHex()
  const outputs = [
    {
      lockingScript,
      customInstructions: JSON.stringify({
        derivationPrefix,
        derivationSuffix,
        payee
      }),
      satoshis: amount,
      outputDescription: 'Fund wallet for remote use'
    }
  ]
  const transaction = await localWallet.createAction({
    outputs,
    description: 'Funding wallet for remote use',
    options: {
      randomizeOutputs: false
    }
  })
  const directTransaction: InternalizeActionArgs = {
    tx: transaction.tx as number[],
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: payer
        }
      }
    ],
    description: 'Incoming wallet funding payment from local wallet'
  }
  const result = await wallet.internalizeAction(directTransaction)
  console.log(chalk.green(`🎉 Wallet funded! ${JSON.stringify(result)}`))
  console.log(chalk.blue(`🔗 View on WhatsOnChain: https://whatsonchain.com/tx/${transaction.txid}`))
}

// Create a readline interface
const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

// Prompt the user for input
rl.question('Enter network (test or main), default main: ', (network) => {
  network = network || 'main'
  if (network !== 'test' && network !== 'main') {
    console.error('❌ Invalid network: ', network);
    process.exit(1);
  }
  rl.question('Enter Wallet Storage URL you want to store the funds with, default https://storage.babbage.systems : ', (storageURL) => {
    storageURL = storageURL || 'https://storage.babbage.systems'
    if (!storageURL.startsWith('https://')) {
      console.error('❌ Invalid storage URL: ', storageURL);
      process.exit(1);
    }
    rl.question('Enter wallet private key: ', (walletPrivateKey) => {
      if (!walletPrivateKey) {
        console.error('❌ Missing required input: ', { walletPrivateKey });
        process.exit(1);
      }
      try {
        PrivateKey.fromHex(walletPrivateKey)
      } catch (err) {
        console.error('❌ Invalid private key: ', walletPrivateKey);
        process.exit(1);
      }
      rl.question('Enter amount in satoshis or leave blank to get balance: ', (amount) => {
        if (amount === '') amount = '0'
        fundWallet(network as 'test' | 'main', storageURL, Number(amount), walletPrivateKey)
        .catch((err) => {
          console.error('❌', err);
          process.exit(1);
        })
        .finally(() => {
          rl.close();
        });
      })
    })
  })
});