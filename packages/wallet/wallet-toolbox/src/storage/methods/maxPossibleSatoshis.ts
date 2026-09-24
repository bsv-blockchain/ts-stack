/**
 * An output of this satoshis amount will be adjusted to the largest fundable amount.
 *
 * Deliberately a leaf module with no other imports: `generateChange.ts` (which
 * re-exports this for backward compatibility) pulls in `StorageProvider.ts`
 * and, transitively, the full signer/create-action module graph. A module
 * that only needs the sentinel value itself — such as
 * `WalletPermissionsManager.ts`, which must resolve a sendMax output's
 * sentinel-valued request without depending on storage internals — should
 * import it from here instead, to avoid dragging in that unrelated graph.
 */
export const maxPossibleSatoshis = 2099999999999999
