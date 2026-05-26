import React from 'react';
import { WalletClient } from '@bsv/sdk';
export type WalletConnectionModalProps = {
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
export declare function WalletConnectionModal({ onLocalWallet, onMobileQR, installUrl, installLabel, mobileLabel, installLinkProps, mobileButtonProps, children, ...rootProps }: WalletConnectionModalProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=WalletConnectionModal.d.ts.map