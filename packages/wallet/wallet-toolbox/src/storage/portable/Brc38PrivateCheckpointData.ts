/** Bounded transaction observations, never semantic or writer authority.
 * Generated clocks and reference values cannot be reconstructed from an
 * archive. They are captured by the actual checkpoint effect, then verified
 * against independently reconstructed row/map effects and stored full bytes. */
interface CheckpointObservation {
  readonly syncStateId: number
  readonly mode: 'NEW' | 'UPDATE' | 'SKIP'
  readonly preparedAt: number
  readonly timestamp: string | null
  readonly refNum: string | null
}
/** v2 is an additive private journal observation. The cursor records the
 * complete page boundary represented by the actual current map; it is never
 * source, semantic, writer or activation authority. Legacy v1 pages always
 * materialized their own map and retain their exact six-key representation. */
export type Brc38PrivateCheckpointData = CheckpointObservation &
  (
    | { readonly protocol: 'brc38-private-checkpoint-data/v1' }
    | { readonly protocol: 'brc38-private-checkpoint-data/v2'; readonly materializedNextRow: number }
  )
function invalid(): never {
  throw new Error('Private checkpoint transaction data differs from its finite original contract')
}
export function brc38PrivateCheckpointData(value: unknown): Readonly<Brc38PrivateCheckpointData> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const item = value as Brc38PrivateCheckpointData
  const incremental = item.protocol === 'brc38-private-checkpoint-data/v2'
  if (
    Object.keys(item)
      .sort((a, b) => Number(a > b) - Number(a < b))
      .join(',') !==
      (incremental
        ? 'materializedNextRow,mode,preparedAt,protocol,refNum,syncStateId,timestamp'
        : 'mode,preparedAt,protocol,refNum,syncStateId,timestamp') ||
    (!incremental && item.protocol !== 'brc38-private-checkpoint-data/v1') ||
    !Number.isSafeInteger(item.syncStateId) ||
    !['NEW', 'UPDATE', 'SKIP'].includes(item.mode) ||
    !Number.isSafeInteger(item.preparedAt) ||
    item.preparedAt < 0
  )
    invalid()
  if (
    incremental &&
    (!Number.isSafeInteger(item.materializedNextRow) ||
      item.materializedNextRow < 0 ||
      item.materializedNextRow > 1000000000)
  )
    invalid()
  if (item.mode === 'SKIP') {
    if (item.timestamp !== null || item.refNum !== null) invalid()
  } else {
    if (
      typeof item.timestamp !== 'string' ||
      item.timestamp.length !== 24 ||
      !Number.isSafeInteger(Date.parse(item.timestamp)) ||
      new Date(item.timestamp).toISOString() !== item.timestamp
    )
      invalid()
    if (item.mode === 'NEW') {
      if (item.syncStateId < 1 || typeof item.refNum !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(item.refNum)) invalid()
    } else if (item.refNum !== null) invalid()
  }
  const observation = {
    protocol: item.protocol,
    syncStateId: item.syncStateId,
    mode: item.mode,
    preparedAt: item.preparedAt,
    timestamp: item.timestamp,
    refNum: item.refNum
  }
  const result: Readonly<Brc38PrivateCheckpointData> = Object.freeze(
    incremental
      ? { ...observation, protocol: 'brc38-private-checkpoint-data/v2', materializedNextRow: item.materializedNextRow }
      : { ...observation, protocol: 'brc38-private-checkpoint-data/v1' }
  )
  if (JSON.stringify(result).length > 512) invalid()
  return result
}

/** Validate observation continuity only. This does not prove the current map
 * or any entity effect; those require actual source/owner and full comparison. */
export function brc38PrivateCheckpointMaterializationCursor(
  data: Readonly<Brc38PrivateCheckpointData>,
  fromRow: number,
  nextRow: number,
  previousCursor: number
): number {
  if (
    !Number.isSafeInteger(fromRow) ||
    fromRow < 0 ||
    !Number.isSafeInteger(nextRow) ||
    nextRow <= fromRow ||
    nextRow > 1000000000 ||
    !Number.isSafeInteger(previousCursor) ||
    previousCursor < 0 ||
    previousCursor > fromRow
  )
    invalid()
  if (data.protocol === 'brc38-private-checkpoint-data/v1') return nextRow
  const cursor = data.materializedNextRow
  if (
    (cursor !== previousCursor && cursor !== nextRow) ||
    (data.mode === 'NEW' && (fromRow !== 0 || cursor !== nextRow)) ||
    (data.mode === 'SKIP' && (previousCursor !== fromRow || cursor !== nextRow))
  )
    invalid()
  return cursor
}
