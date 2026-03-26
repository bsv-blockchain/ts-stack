import * as react_jsx_runtime from 'react/jsx-runtime';
import React from 'react';

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

export { QRPairingCode, type QRPairingCodeProps, useQRPairing };
