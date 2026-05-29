import type { WalletProtocol } from '@bsv/sdk';

/** Default signing protocol. Override per app via AuthProofOptions.protocol. */
export const DEFAULT_PROTOCOL: WalletProtocol = [2, 'bsv auth proof'];

/** Default proof validity window: 2 minutes. */
export const DEFAULT_WINDOW_MS = 2 * 60 * 1000;

/** Default clock-skew tolerance: 30 seconds. */
export const DEFAULT_CLOCK_SKEW_MS = 30 * 1000;
