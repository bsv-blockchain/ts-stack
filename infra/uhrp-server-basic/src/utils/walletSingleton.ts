import { KeyDeriver, PrivateKey, WalletInterface } from '@bsv/sdk'
import { Services, StorageClient, Wallet, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-client';

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as string
const WALLET_STORAGE_URL = process.env.WALLET_STORAGE_URL as string
const BSV_NETWORK = process.env.BSV_NETWORK as 'mainnet' | 'testnet'

let walletInstance: WalletInterface | null = null

export async function getWallet(): Promise<WalletInterface> {
    if (!walletInstance) {
        const chain = BSV_NETWORK === 'mainnet' ? 'main' : 'test'
        const keyDeriver = new KeyDeriver(new PrivateKey(SERVER_PRIVATE_KEY, 'hex'));
        const storageManager = new WalletStorageManager(keyDeriver.identityKey);
        const signer = new WalletSigner(chain, keyDeriver, storageManager);
        const services = new Services(chain);
        const wallet = new Wallet(signer, services);
        const client = new StorageClient(wallet, WALLET_STORAGE_URL);
        await client.makeAvailable();
        await storageManager.addWalletStorageProvider(client);
        return wallet;
    }
    return walletInstance
}
