/** Shared original timestamp/tombstone policy. This returns DATA only; it
 * performs no lookup, parent remapping, profile/source/writer admission or
 * persistence. Identity, creation time and every unrelated current field stay
 * with the caller's complete current row. */
export function mergeSimpleMetadata(
  current: Readonly<{ updated_at: Date }>,
  incoming: Readonly<{ updated_at: Date; isDeleted: boolean }>
):
  | Readonly<{
      updated_at: Date
      isDeleted: boolean
    }>
  | undefined {
  if (!(incoming.updated_at > current.updated_at)) return undefined
  return {
    isDeleted: incoming.isDeleted,
    updated_at: new Date(Math.max(incoming.updated_at.getTime(), current.updated_at.getTime()))
  }
}
