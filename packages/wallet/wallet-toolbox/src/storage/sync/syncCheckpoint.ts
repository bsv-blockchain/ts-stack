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

function invalidCheckpoint(): never {
  throw new TypeError('Invalid sync checkpoint')
}

/** Validate remote progress and return only the fields permitted to advance a sync. */
export function validateSyncCheckpoint(value: SyncCheckpoint, previous?: Partial<SyncCheckpoint>): SyncCheckpoint {
  if (
    value == null ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.syncStateId) ||
    value.syncStateId < 1 ||
    (previous?.syncStateId != null && previous.syncStateId !== value.syncStateId) ||
    !Array.isArray(value.offsets) ||
    value.offsets.length !== entityNames.length
  )
    invalidCheckpoint()
  const offsets = entityNames.map((name, index) => {
    const entry = value.offsets[index]
    if (entry?.name !== name || !Number.isSafeInteger(entry.offset) || entry.offset < 0) invalidCheckpoint()
    return { name, offset: entry.offset }
  })
  let since: Date | undefined
  if (value.since != null) {
    if (!(value.since instanceof Date) && typeof value.since !== 'string') invalidCheckpoint()
    since = new Date(value.since)
    if (!Number.isFinite(since.getTime())) invalidCheckpoint()
  }
  if (previous?.since != null && (since == null || since < previous.since)) invalidCheckpoint()
  if (
    previous != null &&
    since?.getTime() === previous.since?.getTime() &&
    previous.offsets != null &&
    offsets.some((entry, index) => entry.offset < (previous.offsets?.[index]?.offset ?? 0))
  )
    invalidCheckpoint()
  return { syncStateId: value.syncStateId, since, offsets }
}
