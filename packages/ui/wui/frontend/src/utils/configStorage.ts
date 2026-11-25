import { PrivateKey } from '@bsv/sdk';

/** A single config entry. */
export interface WalletConfig {
    id: string; // unique
    name: string; // user-chosen name
    privateKey: string; // 64-hex
    network: 'main' | 'test';
    storage: string; // full URL
    pubKeySuffix: string; // last 4 hex from compressed pubkey
}

/** We store an array of these under "brc100Configs" in localStorage. */
const STORAGE_KEY = 'brc100Configs';
const ACTIVE_ID_KEY = 'brc100ActiveConfig';

export function getAllConfigs(): WalletConfig[] {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return [];
        return JSON.parse(stored);
    } catch {
        return [];
    }
}

export function saveAllConfigs(configs: WalletConfig[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

export function getActiveConfigId(): string | null {
    return localStorage.getItem(ACTIVE_ID_KEY);
}

export function setActiveConfigId(id: string | null) {
    if (id) localStorage.setItem(ACTIVE_ID_KEY, id);
    else localStorage.removeItem(ACTIVE_ID_KEY);
}

export function getConfigById(id: string): WalletConfig | null {
    const all = getAllConfigs();
    return all.find((c) => c.id === id) || null;
}

export function addNewConfig(
    name: string,
    privateKey: string,
    network: 'main' | 'test',
    storage: string
): WalletConfig {
    // Compute short pubkey suffix
    const suffix = computePubKeySuffix(privateKey);
    const id = generateUniqueId();
    const newConfig: WalletConfig = {
        id,
        name,
        privateKey,
        network,
        storage,
        pubKeySuffix: suffix
    };
    const all = getAllConfigs();
    all.push(newConfig);
    saveAllConfigs(all);
    return newConfig;
}

export function updateConfig(
    id: string,
    patch: Partial<Pick<WalletConfig, 'name' | 'privateKey' | 'network' | 'storage'>>
): WalletConfig | null {
    const all = getAllConfigs();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    const original = all[idx];
    const updated = { ...original, ...patch };
    if (patch.privateKey) {
        updated.pubKeySuffix = computePubKeySuffix(patch.privateKey);
    }
    all[idx] = updated;
    saveAllConfigs(all);
    return updated;
}

export function removeConfig(id: string) {
    const all = getAllConfigs();
    const filtered = all.filter((c) => c.id !== id);
    saveAllConfigs(filtered);
    // If it was active, we should unset it:
    const active = getActiveConfigId();
    if (active === id) {
        setActiveConfigId(null);
    }
}

/** Utility to compute last 4 hex of compressed pubkey. */
function computePubKeySuffix(privKeyHex: string): string {
    return new PrivateKey(privKeyHex, 'hex').toPublicKey().toString().slice(-4);
}

function generateUniqueId(): string {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
}
