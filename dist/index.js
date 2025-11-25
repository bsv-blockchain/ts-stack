#!/usr/bin/env node
import { randomBytes } from 'crypto';
import chalk from 'chalk';
import { createInterface } from 'readline';
import { WalletClient, PrivateKey, PublicKey, P2PKH, KeyDeriver } from '@bsv/sdk';
import { Wallet, WalletStorageManager, WalletSigner, Services, StorageClient } from '@bsv/wallet-toolbox';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
async function makeWallet(chain, storageURL, privateKey) {
    const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, 'hex'));
    const storageManager = new WalletStorageManager(keyDeriver.identityKey);
    const signer = new WalletSigner(chain, keyDeriver, storageManager);
    const services = new Services(chain);
    const wallet = new Wallet(signer, services);
    const client = new StorageClient(wallet, storageURL);
    await client.makeAvailable();
    await storageManager.addWalletStorageProvider(client);
    const { totalOutputs } = await wallet.listOutputs({ basket: '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8' }, 'admin.com');
    console.log(chalk.green(`💰 Wallet balance: ${totalOutputs}`));
    return wallet;
}
async function fundWallet(network, storageURL, amount, walletPrivateKey) {
    const wallet = await makeWallet(network, storageURL, walletPrivateKey);
    if (amount === 0)
        return;
    const remote = await wallet.isAuthenticated({});
    console.log({ remote });
    const localWallet = new WalletClient('secure-json-api', 'deggen.com');
    const local = await localWallet.isAuthenticated({});
    console.log({ local });
    try {
        const { version } = await localWallet.getVersion();
        console.log(chalk.blue(`💰 Using local wallet version: ${version}`));
    }
    catch (err) {
        console.error(chalk.red('❌ Metanet Desktop is not installed or not running.'));
        console.log(chalk.blue('👉 Download Metanet Desktop: https://metanet.bsvb.tech'));
        process.exit(1);
    }
    const derivationPrefix = randomBytes(10).toString('base64');
    const derivationSuffix = randomBytes(10).toString('base64');
    const { publicKey: payer } = await localWallet.getPublicKey({
        identityKey: true
    });
    const payee = new PrivateKey(walletPrivateKey, 'hex').toPublicKey().toString();
    const { publicKey: derivedPublicKey } = await localWallet.getPublicKey({
        counterparty: payee,
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`
    });
    const lockingScript = new P2PKH()
        .lock(PublicKey.fromString(derivedPublicKey).toAddress())
        .toHex();
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
    ];
    const transaction = await localWallet.createAction({
        outputs,
        description: 'Funding wallet for remote use',
        options: {
            randomizeOutputs: false
        }
    });
    const directTransaction = {
        tx: transaction.tx,
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
    };
    const result = await wallet.internalizeAction(directTransaction);
    console.log(chalk.green(`🎉 Wallet funded! ${JSON.stringify(result)}`));
    console.log(chalk.blue(`🔗 View on WhatsOnChain: https://whatsonchain.com/tx/${transaction.txid}`));
}
// Parse command-line arguments
const args = process.argv.slice(2);
function showHelp(errorMessage) {
    if (errorMessage) {
        console.error(chalk.red(`\n❌ ${errorMessage}\n`));
    }
    console.log(chalk.bold('fund-metanet') + ' - Fund a Metanet wallet\n');
    console.log(chalk.bold('USAGE:'));
    console.log('  npx fund-metanet [OPTIONS]\n');
    console.log(chalk.bold('OPTIONS:'));
    console.log('  --chain <network>           Network to use: "test" or "main" (required)');
    console.log('  --private-key <hex>         Wallet private key in hex format (required)');
    console.log('  --storage-url <url>         Storage provider URL');
    console.log('                              (default: https://store-us-1.bsvb.tech)');
    console.log('  --satoshis <amount>         Amount to fund in satoshis');
    console.log('                              (omit to check balance only)');
    console.log('  --help                      Show this help message\n');
    console.log(chalk.bold('EXAMPLES:'));
    console.log('  # Fund wallet with 1000 satoshis:');
    console.log('  npx fund-metanet --chain main --private-key abc123... --satoshis 1000\n');
    console.log('  # Check balance only:');
    console.log('  npx fund-metanet --chain main --private-key abc123...\n');
    console.log('  # Use custom storage URL:');
    console.log('  npx fund-metanet --chain main --private-key abc123... \\');
    console.log('    --storage-url https://store-us-1.bsvb.tech --satoshis 500\n');
    console.log('  # Interactive mode (no arguments):');
    console.log('  npx fund-metanet\n');
    process.exit(errorMessage ? 1 : 0);
}
// Check for help flag
if (args.includes('--help') || args.includes('-h')) {
    showHelp();
}
const getArg = (name) => {
    const index = args.findIndex(arg => arg === `--${name}`);
    if (index !== -1 && index + 1 < args.length) {
        return args[index + 1];
    }
    return undefined;
};
const cliNetwork = getArg('chain') || getArg('network');
const cliStorageURL = getArg('storage-url') || getArg('storageURL');
const cliPrivateKey = getArg('private-key') || getArg('privateKey');
const cliSatoshis = getArg('satoshis');
// Check if any CLI arguments were provided
const hasCliArgs = args.length > 0;
// If CLI arguments are provided, validate them
if (hasCliArgs && args[0] !== '--help' && args[0] !== '-h') {
    // Check for required arguments
    if (!cliNetwork) {
        showHelp('Missing required argument: --chain');
    }
    if (!cliPrivateKey) {
        showHelp('Missing required argument: --private-key');
    }
}
// If all required arguments are provided via CLI, use them directly
if (cliNetwork && cliPrivateKey) {
    const network = cliNetwork;
    if (network !== 'test' && network !== 'main') {
        showHelp(`Invalid network: ${network}. Must be "test" or "main"`);
    }
    const storageURL = cliStorageURL || 'https://store-us-1.bsvb.tech';
    if (!storageURL.startsWith('https://')) {
        showHelp(`Invalid storage URL: ${storageURL}. Must start with "https://"`);
    }
    const walletPrivateKey = cliPrivateKey;
    try {
        PrivateKey.fromHex(walletPrivateKey);
    }
    catch (err) {
        showHelp(`Invalid private key: Must be valid hex format`);
    }
    const amount = cliSatoshis ? Number(cliSatoshis) : 0;
    if (cliSatoshis && (isNaN(amount) || amount < 0)) {
        showHelp(`Invalid satoshis: ${cliSatoshis}. Must be a positive number`);
    }
    fundWallet(network, storageURL, amount, walletPrivateKey)
        .catch((err) => {
        console.error('❌', err);
        process.exit(1);
    });
}
else if (!hasCliArgs) {
    // Fall back to interactive prompts
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout
    });
    // Prompt the user for input
    rl.question('Enter network (test or main), default main: ', (network) => {
        network = network || 'main';
        if (network !== 'test' && network !== 'main') {
            console.error('❌ Invalid network: ', network);
            process.exit(1);
        }
        rl.question('Enter Wallet Storage URL you want to store the funds with, default https://store-us-1.bsvb.tech : ', (storageURL) => {
            storageURL = storageURL || 'https://store-us-1.bsvb.tech';
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
                    PrivateKey.fromHex(walletPrivateKey);
                }
                catch (err) {
                    console.error('❌ Invalid private key: ', walletPrivateKey);
                    process.exit(1);
                }
                rl.question('Enter amount in satoshis or leave blank to get balance: ', (amount) => {
                    if (amount === '')
                        amount = '0';
                    fundWallet(network, storageURL, Number(amount), walletPrivateKey)
                        .catch((err) => {
                        console.error('❌', err);
                        process.exit(1);
                    })
                        .finally(() => {
                        rl.close();
                    });
                });
            });
        });
    });
}
