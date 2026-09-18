import type { SyncCheckpoint } from '../../sdk/WalletStorage.interfaces'

const entityNames = [
  'provenTx',
  'outputBasket',
  'outputTag',
  'txLabel',
  'transaction',
  'output',
  'txLabelMap',
  'outputTagMap',
  'certificate',
  'certificateField',
  'commission',
  'provenTxReq'
]

/** Validate remote progress and return only the fields permitted to advance a sync. */
export function validateSyncCheckpoint(value: SyncCheckpoint, previous?: Partial<SyncCheckpoint>): SyncCheckpoint {
  const invalid = (): never => {
    throw new TypeError('Invalid sync checkpoint')
  }
  if (
    value == null ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.syncStateId) ||
    value.syncStateId < 1 ||
    (previous?.syncStateId != null && previous.syncStateId !== value.syncStateId) ||
    !Array.isArray(value.offsets) ||
    value.offsets.length !== entityNames.length
  )
    invalid()
  const offsets = entityNames.map((name, index) => {
    const entry = value.offsets[index]
    if (entry?.name !== name || !Number.isSafeInteger(entry.offset) || entry.offset < 0) invalid()
    return { name, offset: entry.offset }
  })
  let since: Date | undefined
  if (value.since != null) {
    if (!(value.since instanceof Date) && typeof value.since !== 'string') invalid()
    since = new Date(value.since)
    if (!Number.isFinite(since.getTime())) invalid()
  }
  if (previous?.since != null && (since == null || since < previous.since)) invalid()
  return { syncStateId: value.syncStateId, since, offsets }
}
