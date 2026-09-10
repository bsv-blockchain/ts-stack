import type { RequestSyncChunkArgs, SyncChunk } from '../../sdk/WalletStorage.interfaces'

/** Per-copy work budget. Bytes alone cannot bound network-backed proof checks. */
export class SyncPageBudget {
  private maxItems = 64

  apply(args: RequestSyncChunkArgs): RequestSyncChunkArgs {
    return { ...args, maxItems: Math.min(args.maxItems, this.maxItems) }
  }

  committed(chunk: SyncChunk, elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return
    const records = Object.values(chunk).reduce<number>((count, value) =>
      count + (Array.isArray(value) ? value.length : 0), 0)
    if (records === 0) return
    // Leave headroom under the authentication deadline and limit growth when
    // moving from cheap metadata to network-backed proof validation.
    const ceiling = (chunk.provenTxs?.length ?? 0) > 0 ? 128 : 1000
    const suggested = Math.floor(records * 5000 / Math.max(1, elapsedMs))
    this.maxItems = Math.max(1, Math.min(ceiling, this.maxItems * 2, suggested))
  }
}
