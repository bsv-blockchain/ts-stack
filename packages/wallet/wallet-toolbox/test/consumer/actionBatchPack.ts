import { decodeActionBatchPack } from '@bsv/wallet-toolbox/out/src/utility/actionBatchPack'
import type { ActionBatchPackItem } from '@bsv/wallet-toolbox/out/src/sdk'

/** Declaration consumer: decoded payloads are real views while existing
 * consumers of the wider input item type remain compatible. */
export function readDecodedPack(bytes: Uint8Array): void {
  const decoded = decodeActionBatchPack(bytes, 1024, 16)
  const legacy: ActionBatchPackItem[] = decoded
  for (const item of decoded) {
    const view: Uint8Array = item.bytes
    const backing: ArrayBufferLike = item.bytes.buffer
    void view
    void backing
  }
  void legacy
}
