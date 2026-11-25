import React, { createContext, useState, useEffect, useContext } from 'react';
import { WalletInterface } from '@bsv/sdk';
import makeWallet from '../utils/makeWallet';
import {
    getActiveConfigId,
    setActiveConfigId,
    getConfigById
} from '../utils/configStorage';

/**
 * We define the shape of our WalletContext. We track:
 *  - the currently loaded wallet object (or null if none)
 *  - whether we're still loading the wallet from localStorage's "active config"
 *  - a function to set the active config by ID (which triggers wallet creation)
 */
interface WalletContextValue {
    wallet: WalletInterface | null;
    loadingInitialWallet: boolean;
    setWallet: React.Dispatch<React.SetStateAction<WalletInterface | null>>;

    // A helper to pick a new config ID from the UI. We'll handle all the logic.
    pickActiveConfig: (configId: string | null) => Promise<void>;
}

const WalletContext = createContext<WalletContextValue>({
    wallet: null,
    loadingInitialWallet: true,
    setWallet: () => { },
    pickActiveConfig: async () => { }
});

export const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [wallet, setWallet] = useState<WalletInterface | null>(null);
    const [loadingInitialWallet, setLoadingInitialWallet] = useState(true);

    // On mount, check if we have an active config. If so, build a wallet from it.
    useEffect(() => {
        (async () => {
            try {
                const activeId = getActiveConfigId();
                if (activeId) {
                    const c = getConfigById(activeId);
                    if (c) {
                        const w = await makeWallet(c.network, c.privateKey, c.storage);
                        setWallet(w);
                    }
                }
            } catch (err) {
                console.error('Error loading initial wallet config:', err);
            } finally {
                setLoadingInitialWallet(false);
            }
        })();
    }, []);

    // A helper that picks a config by ID (or null).
    async function pickActiveConfig(configId: string | null) {
        setLoadingInitialWallet(true);
        setWallet(null);

        if (!configId) {
            // Means user wants "no active" config
            setActiveConfigId(null);
            setLoadingInitialWallet(false);
            return;
        }
        // Otherwise, load the config
        try {
            setActiveConfigId(configId);
            const c = getConfigById(configId);
            if (!c) {
                throw new Error('Invalid config ID');
            }
            const w = await makeWallet(c.network, c.privateKey, c.storage);
            setWallet(w);
        } catch (err) {
            console.error('Error picking config:', err);
            // revert to no config
            setActiveConfigId(null);
        } finally {
            setLoadingInitialWallet(false);
        }
    }

    return (
        <WalletContext.Provider
            value={{
                wallet,
                setWallet,
                loadingInitialWallet,
                pickActiveConfig
            }}
        >
            {children}
        </WalletContext.Provider>
    );
};

export function useWallet() {
    return useContext(WalletContext);
}
