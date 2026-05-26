import type { WalletInterface } from '@bsv/sdk';
import { type WalletRelayClientOptions } from '../client/WalletRelayClient.js';
import type { SessionInfo, RequestLogEntry, WalletResponse, WalletMethodName } from '../types.js';
export type UseWalletRelayClientOptions = Omit<WalletRelayClientOptions, 'onSessionChange' | 'onLogChange' | 'onError'> & {
    /**
     * Set to `false` to prevent automatically creating a session on mount.
     * Default: `true`
     */
    autoCreate?: boolean;
    /**
     * Set to `true` to attempt resuming a persisted session on mount even when
     * `autoCreate` is `false`. Lets a hook consumer survive page refreshes
     * without auto-creating a fresh session for users who never paired.
     * Default: `false` (so existing `autoCreate: false` consumers behave unchanged).
     *
     * Has no effect when `autoCreate !== false` — resume is already part of that path.
     */
    autoResume?: boolean;
};
/**
 * React hook that wraps WalletRelayClient with React state.
 *
 * Replaces the template's `useWalletSession` hook — drop-in with a cleaner API.
 *
 * ```tsx
 * const { session, log, error, createSession, resumeSession, cancelSession, sendRequest } = useWalletRelayClient()
 *
 * // Stop polling and reset state (e.g. on page navigation away from a QR screen):
 * useEffect(() => () => { cancelSession() }, [])
 *
 * // With options:
 * const { session } = useWalletRelayClient({ apiUrl: 'https://api.example.com', autoCreate: false })
 * ```
 */
export declare function useWalletRelayClient(options?: UseWalletRelayClientOptions): {
    session: SessionInfo | null;
    log: RequestLogEntry[];
    error: string | null;
    createSession: () => Promise<SessionInfo>;
    resumeSession: () => Promise<SessionInfo | null>;
    cancelSession: () => void;
    sendRequest: (method: WalletMethodName, params?: unknown) => Promise<WalletResponse>;
    wallet: Pick<WalletInterface, "getPublicKey" | "encrypt" | "decrypt" | "createSignature" | "revealCounterpartyKeyLinkage" | "createHmac" | "verifyHmac" | "verifySignature" | "createAction" | "signAction" | "listActions" | "internalizeAction" | "listOutputs" | "acquireCertificate" | "listCertificates" | "relinquishCertificate"> | null;
};
//# sourceMappingURL=useWalletRelayClient.d.ts.map