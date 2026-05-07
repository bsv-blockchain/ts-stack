import { useCallback } from 'react'

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
export function useQRPairing(
  pairingUri: string,
  options?: {
    /** Override the URL-opening strategy (required in React Native). */
    openUrl?: (uri: string) => void
  }
): { open: () => void; pairingUri: string } {
  const open = useCallback(() => {
    if (options?.openUrl) {
      options.openUrl(pairingUri)
    } else if (globalThis.window !== undefined) {
      globalThis.window.location.href = pairingUri
    }
  }, [pairingUri, options?.openUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  return { open, pairingUri }
}
