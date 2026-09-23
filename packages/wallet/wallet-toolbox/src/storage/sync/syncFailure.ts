import { WalletErrorFromJson } from '../../sdk/WalletErrorFromJson'
import { WERR_INVALID_OPERATION, WERR_NETWORK_CHAIN } from '../../sdk/WERR_errors'
import type { RequestSyncChunkArgs } from '../../sdk/WalletStorage.interfaces'
import type { ProcessSyncChunkResult } from '../../sdk/WalletStorage.interfaces'
import type { TableSettings } from '../schema/tables'

const supportedChains = new Set(['main', 'test', 'stn', 'ttn', 'tstn', 'mock'])

/** Read-only preflight, before user registration or a destination checkpoint is created. */
export function assertSyncNetwork(reader: TableSettings, writer: TableSettings): void {
  if (!supportedChains.has(reader.chain) || !supportedChains.has(writer.chain) || reader.chain !== writer.chain) {
    throw new WERR_NETWORK_CHAIN('Live sync requires matching declared network chains on both storage providers.')
  }
}

/**
 * A returned failure has precedence over counters, completion and checkpoint hints.
 * Shipped providers normally throw; external providers may use the public error field.
 */
export function throwSyncResultError(result: ProcessSyncChunkResult): void {
  const error = result.error
  if (error == null) return
  if (error instanceof Error) throw error
  throw WalletErrorFromJson(error)
}

/** An unfinished page must advance durable progress, never spin on a provider's empty success. */
export function assertSyncProgress(before: RequestSyncChunkArgs, after: RequestSyncChunkArgs): void {
  const sameSince = before.since?.getTime() === after.since?.getTime()
  if (sameSince && after.offsets.every((entry, index) => entry.offset === before.offsets[index]?.offset)) {
    throw new WERR_INVALID_OPERATION(
      'Sync provider reported an unfinished page without advancing its durable checkpoint.'
    )
  }
}
