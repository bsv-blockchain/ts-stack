import type { WalletProtocol } from '@bsv/sdk'

/** Canonical wallet protocol used by every Metanet Apps token. */
export const METANET_APPS_PROTOCOL: WalletProtocol = [1, 'metanet apps']

/** Canonical BRC-42 derivation key used to sign and lock app tokens. */
export const METANET_APPS_KEY_ID = '1'

export const METANET_APPS_TOPIC = 'tm_apps'
export const METANET_APPS_LOOKUP_SERVICE = 'ls_apps'
