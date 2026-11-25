import {
    Chain,
    Wallet,
    WalletSigner,
    PrivilegedKeyManager,
    WalletStorageManager,
    StorageClient,
    Services,
    createIdbChaintracks,
    createDefaultWalletServicesOptions
} from '@bsv/wallet-toolbox-client';
import { WalletClient, WalletInterface, KeyDeriver, PrivateKey } from '@bsv/sdk'

const walletServices: Map<Chain, Services | undefined> = new Map();
const pendingInitializations: Map<Chain, Promise<Services>> = new Map();

async function getWalletServices(chain: Chain, source: 'localIdb' | 'babbage.systems'): Promise<Services> {
    const pending = pendingInitializations.get(chain);
    if (pending) {
        return pending;
    }
    let s = walletServices.get(chain);
    if (!s) {
        const u = undefined
        const initPromise = (async() => {
            try {
                if (source === 'localIdb') {
                    // Try to create local in-browser IndexedDB block headers database
                    const wocApiKey = '' // Replace with secret WhatsOnChain API key for reliable performance.
                    // The default cdn is https://cdn.projectbabbage.com/blockheaders
                    const cdnUrl = u; //'http://localhost:8300/blockheaders'
                    const { chaintracks, available } = await createIdbChaintracks(
                        chain, wocApiKey, u, u, u, cdnUrl);
                    try {
                        await available;
                        const serviceOptions = createDefaultWalletServicesOptions(
                            chain, u, u, u, u, u, u, chaintracks);
                        s = new Services(serviceOptions);
                        walletServices.set(chain, s);
                        return s
                    } catch (e) {
                        // fall back to babbage.systems
                        console.log(`Error creating local IDB chaintracks: ${e}`);
                        console.log(`Falling back to babbage.systems service for chaintracks headers`);
                        try {
                            await chaintracks.destroy();
                        } catch {
                            // attempt cleanup of chaintracks ingestor services.
                        }
                    }
                }
                // Use babbage.systems for chaintracks headers
                const serviceOptions = createDefaultWalletServicesOptions(chain);
                s = new Services(serviceOptions);
                walletServices.set(chain, s);
                return s
            } finally {
                pendingInitializations.delete(chain);
            }
        }) ()
        pendingInitializations.set(chain, initPromise);
        return initPromise
    }
    return s;
}

export default async function makeWallet(chain: 'test' | 'main' | 'local', privateKey: string, storageURL: string): Promise<WalletInterface> {
    if (chain === 'local') {
        return new WalletClient()
    }
    const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, 'hex'));
    const storageManager = new WalletStorageManager(keyDeriver.identityKey);
    const signer = new WalletSigner(chain, keyDeriver, storageManager);
    const services = await getWalletServices(chain, 'localIdb');
    const wallet = new Wallet(signer, services, undefined, new PrivilegedKeyManager(async (reason) => {
        const key = window.prompt(`Privileged key requested. Privileged keys are not stored in local storage by WUI. You will need to provide it every time. Reason:\n\n${reason}\n\nPaste your privileged key in hex. If no value provided, a random key will be generated instead:`);
        if (!key) {
            return PrivateKey.fromRandom()
        } else {
            return new PrivateKey(key, 'hex')
        }
    }));
    const client = new StorageClient(wallet, storageURL);
    await client.makeAvailable();
    await storageManager.addWalletStorageProvider(client);
    return wallet;
}