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
export declare function useQRPairing(pairingUri: string, options?: {
    /** Override the URL-opening strategy (required in React Native). */
    openUrl?: (uri: string) => void;
}): {
    open: () => void;
    pairingUri: string;
};
//# sourceMappingURL=useQRPairing.d.ts.map