import * as react_jsx_runtime from 'react/jsx-runtime';
import React from 'react';
import { WalletInterface, WalletClient } from '@bsv/sdk';
import { a as WalletRelayClientOptions } from './WalletRelayClient-CqfjvQpH.cjs';
import { f as SessionInfo, h as RequestLogEntry, g as WalletMethodName, k as WalletResponse } from './types-BIOdtOVN.cjs';

type QRPairingCodeProps = {
    /**
     * Base64 data URL of the QR code image.
     * Returned by `WalletRelayService.createSession()` or `QRSessionManager.generateQRCode()`.
     */
    qrDataUrl: string;
    /**
     * The `wallet://pair?…` pairing URI.
     * Used as the deeplink target when the QR is tapped on a mobile browser.
     */
    pairingUri: string;
    /**
     * Override the deeplink action.
     * - Web default: `window.location.href = pairingUri`
     * - React Native: pass `(uri) => Linking.openURL(uri)`
     */
    onPress?: (pairingUri: string) => void;
    /**
     * Props forwarded to the inner `<img>` element.
     * Use this to set `alt`, `style`, `className`, or any other image attribute.
     * Ignored when `children` is provided.
     */
    imageProps?: React.ImgHTMLAttributes<HTMLImageElement>;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onClick'>;
/**
 * Renders a tappable QR code for the BSV wallet pairing flow.
 *
 * Tapping opens the pairing URI as a deeplink (`wallet://pair?…`), which
 * launches the BSV-browser app on mobile instead of going through the full
 * scan-and-connect flow — the user is already on the mobile device.
 *
 * **Custom styling** — full control via standard HTML/CSS props:
 * ```tsx
 * <QRPairingCode
 *   qrDataUrl={session.qrDataUrl}
 *   pairingUri={session.pairingUri}
 *   className="rounded-xl shadow-lg"
 *   imageProps={{ className: 'w-64 h-64', alt: 'Scan to connect wallet' }}
 * />
 * ```
 *
 * **Replace the image entirely** with `children`:
 * ```tsx
 * <QRPairingCode qrDataUrl={...} pairingUri={...}>
 *   <MyCustomQRRenderer data={pairingUri} size={256} />
 * </QRPairingCode>
 * ```
 *
 * **React Native** — use the `useQRPairing` hook directly:
 * ```tsx
 * import { Linking } from 'react-native'
 * const { open } = useQRPairing(pairingUri, { openUrl: Linking.openURL })
 * return (
 *   <TouchableOpacity onPress={open}>
 *     <Image source={{ uri: qrDataUrl }} style={styles.qr} />
 *   </TouchableOpacity>
 * )
 * ```
 */
declare function QRPairingCode({ qrDataUrl, pairingUri, onPress, imageProps, children, ...divProps }: QRPairingCodeProps): react_jsx_runtime.JSX.Element;

/**
 * Cross-platform hook that returns an `open()` function to trigger the
 * wallet deeplink from the pairing URI.
 *
 * **Web** (default): sets `window.location.href` which hands off to the
 * installed BSV-browser app if the OS recognises the `wallet://` scheme.
 *
 * **React Native**: pass `openUrl` to use `Linking.openURL` instead:
 * ```ts
 * import { Linking } from 'react-native'
 * const { open } = useQRPairing(pairingUri, { openUrl: Linking.openURL })
 * ```
 */
declare function useQRPairing(pairingUri: string, options?: {
    /** Override the URL-opening strategy (required in React Native). */
    openUrl?: (uri: string) => void;
}): {
    open: () => void;
    pairingUri: string;
};

type UseWalletRelayClientOptions = Omit<WalletRelayClientOptions, 'onSessionChange' | 'onLogChange' | 'onError'> & {
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
declare function useWalletRelayClient(options?: UseWalletRelayClientOptions): {
    session: SessionInfo | null;
    log: RequestLogEntry[];
    error: string | null;
    createSession: () => Promise<SessionInfo>;
    resumeSession: () => Promise<SessionInfo | null>;
    cancelSession: () => void;
    sendRequest: (method: WalletMethodName, params?: unknown) => Promise<WalletResponse>;
    wallet: Pick<WalletInterface, "getPublicKey" | "encrypt" | "decrypt" | "createSignature" | "revealCounterpartyKeyLinkage" | "createHmac" | "verifyHmac" | "verifySignature" | "createAction" | "signAction" | "listActions" | "internalizeAction" | "listOutputs" | "acquireCertificate" | "listCertificates" | "relinquishCertificate"> | null;
};

type QRDisplayProps = {
    /**
     * Current session. Renders a loading placeholder (data-state="loading") when null.
     * Pass the SessionInfo returned by WalletRelayClient or useWalletRelayClient.
     */
    session: SessionInfo | null;
    /**
     * Called when the user clicks the refresh button (shown when status is "expired" or "disconnected").
     * Typically: `() => createSession()`
     */
    onRefresh: () => void;
    /**
     * Props forwarded to the loading placeholder element.
     * Use to set className / style on the placeholder shown while session is null.
     */
    loadingProps?: React.HTMLAttributes<HTMLDivElement>;
    /**
     * Props forwarded to the status text element.
     * The element also gets a `data-qr-status` attribute set to the current status value.
     */
    statusProps?: React.HTMLAttributes<HTMLSpanElement>;
    /**
     * Props forwarded to the refresh button (rendered when status is "expired" or "disconnected").
     */
    refreshButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
    /**
     * Props forwarded to the inner QRPairingCode component.
     * Use `qrProps.imageProps` to style the QR image, or `qrProps.onPress` to override deeplink.
     */
    qrProps?: Omit<QRPairingCodeProps, 'qrDataUrl' | 'pairingUri'>;
} & React.HTMLAttributes<HTMLDivElement>;
/**
 * Unstyled QR display with status indicator and session refresh.
 *
 * Shows a loading placeholder while `session` is null, then the QR code
 * with a status label. When the session expires a refresh button appears.
 *
 * All visual styling is up to the consumer — use `className` / `style` on
 * the root and element-level props for sub-elements. The root div and each
 * sub-element carry `data-*` attributes you can target with CSS selectors.
 *
 * @example
 * ```tsx
 * <QRDisplay
 *   session={session}
 *   onRefresh={createSession}
 *   className="flex flex-col items-center gap-4"
 *   qrProps={{ imageProps: { className: 'w-64 h-64' } }}
 *   statusProps={{ className: 'text-sm font-medium' }}
 *   refreshButtonProps={{ className: 'text-blue-600 hover:underline text-sm' }}
 * />
 * ```
 */
declare function QRDisplay({ session, onRefresh, loadingProps, statusProps, refreshButtonProps, qrProps, children, ...rootProps }: QRDisplayProps): react_jsx_runtime.JSX.Element;

type WalletConnectionModalProps = {
    /** Called immediately when a local wallet is detected and authenticated. No UI is shown. */
    onLocalWallet: (wallet: WalletClient) => void;
    /** Called when the user clicks the "Connect via Mobile QR" button. */
    onMobileQR: () => void;
    /**
     * URL to send the user to for installing a BSV wallet.
     * Default: 'https://desktop.bsvb.tech'
     */
    installUrl?: string;
    /** Override the install link text. Default: 'Install BSV Wallet' */
    installLabel?: string;
    /** Override the mobile QR button text. Default: 'Connect via Mobile QR' */
    mobileLabel?: string;
    /** Props forwarded to the install anchor element. */
    installLinkProps?: React.AnchorHTMLAttributes<HTMLAnchorElement>;
    /** Props forwarded to the mobile QR button element. */
    mobileButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
} & React.HTMLAttributes<HTMLDivElement>;
/**
 * Unstyled wallet connection chooser with local wallet detection.
 *
 * Detects whether a local BSV wallet (MetaNet Client / BabbageSDK) is
 * available. If found, calls `onLocalWallet` immediately with no UI shown.
 * If not found, renders a div containing an install link and a mobile QR
 * button — style it however you like via `className` / `style`.
 *
 * Returns `null` while detecting or after a local wallet is found.
 *
 * Override the inner content entirely by passing `children`.
 *
 * @example
 * ```tsx
 * <WalletConnectionModal
 *   onLocalWallet={(wallet) => setWallet(wallet)}
 *   onMobileQR={() => setShowQR(true)}
 *   className="fixed inset-0 flex items-center justify-center bg-black/50"
 *   installLinkProps={{ className: 'btn-primary' }}
 *   mobileButtonProps={{ className: 'btn-secondary' }}
 * />
 * ```
 */
declare function WalletConnectionModal({ onLocalWallet, onMobileQR, installUrl, installLabel, mobileLabel, installLinkProps, mobileButtonProps, children, ...rootProps }: WalletConnectionModalProps): react_jsx_runtime.JSX.Element | null;

type RequestLogProps = {
    /**
     * Log entries to display, newest first.
     * Use the `log` value from `useWalletRelayClient` or `WalletRelayClient`.
     */
    entries: RequestLogEntry[];
    /**
     * Props forwarded to the empty-state element (rendered when entries is empty).
     * The element gets `data-state="empty"`.
     */
    emptyProps?: React.HTMLAttributes<HTMLDivElement>;
    /**
     * Props forwarded to each entry element.
     * Each entry also gets a `data-state` attribute of `pending`, `error`, or `ok`.
     */
    entryProps?: React.HTMLAttributes<HTMLDivElement>;
} & React.HTMLAttributes<HTMLDivElement>;
/**
 * Unstyled RPC request log showing call history with status and results.
 *
 * Each entry element carries a `data-state` attribute (`pending`, `error`, `ok`)
 * so you can target states with CSS selectors without any class-based logic.
 *
 * @example
 * ```tsx
 * <RequestLog
 *   entries={log}
 *   className="flex flex-col gap-2 overflow-y-auto max-h-72"
 *   entryProps={{ className: 'rounded border p-3 text-xs font-mono' }}
 * />
 * ```
 */
declare function RequestLog({ entries, emptyProps, entryProps, children, ...rootProps }: RequestLogProps): react_jsx_runtime.JSX.Element;

export { QRDisplay, type QRDisplayProps, QRPairingCode, type QRPairingCodeProps, RequestLog, type RequestLogProps, type UseWalletRelayClientOptions, WalletConnectionModal, type WalletConnectionModalProps, useQRPairing, useWalletRelayClient };
