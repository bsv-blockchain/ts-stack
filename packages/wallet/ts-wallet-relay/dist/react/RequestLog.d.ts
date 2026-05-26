import React from 'react';
import type { RequestLogEntry } from '../types.js';
export type RequestLogProps = {
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
export declare function RequestLog({ entries, emptyProps, entryProps, children, ...rootProps }: RequestLogProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=RequestLog.d.ts.map