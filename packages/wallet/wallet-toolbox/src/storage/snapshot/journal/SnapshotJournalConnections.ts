import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

export class SnapshotJournalConnectionCleanupError extends Error {
  constructor(override readonly cause: unknown) {
    super('Snapshot journal connection cleanup failed')
    this.name = 'SnapshotJournalConnectionCleanupError'
  }
}

interface ReservedConnection {
  owner: Knex
  connection: unknown
}

/** Reserve both dedicated pools before any caller can obtain a writer barrier.
 * The surrounding retained-view lifecycle controls cancellation and admission:
 * assertActive must reject after cancellation/expiry, and its closed promise
 * must await this function even when opening has already rejected. These pools
 * must be owned by that lifecycle, and destroyed after it settles. This helper
 * does not establish matching backend identity, begin a transaction or publish
 * a reader. Acquisition failures still drain the other pending acquisition.
 */
export async function withSnapshotJournalConnections<T>(
  writer: Knex,
  reader: Knex,
  assertActive: () => void,
  run: (writerConnection: unknown, readerConnection: unknown) => Promise<T>,
  release: (owner: Knex, connection: unknown) => Promise<void> = async (owner, connection) => {
    await owner.client.releaseConnection(connection)
  }
): Promise<T> {
  assertActive()
  if (writer === reader || writer.client === reader.client || writer.isTransaction || reader.isTransaction)
    throw new WERR_INVALID_OPERATION('Snapshot capture requires two independent owned connection pools')
  const reserved: ReservedConnection[] = []
  async function reserve(owner: Knex): Promise<unknown> {
    const connection: unknown = await owner.client.acquireConnection()
    reserved.push({ owner, connection })
    return connection
  }
  let result: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    const [write, read] = await Promise.allSettled([reserve(writer), reserve(reader)])
    if (write.status === 'rejected' || read.status === 'rejected')
      throw new AggregateError(
        [write, read].filter(value => value.status === 'rejected').map(value => value.reason),
        'Snapshot connection acquisition failed'
      )
    if (write.value === read.value)
      throw new WERR_INVALID_OPERATION('Snapshot pools returned the same native connection')
    assertActive()
    result = { ok: true, value: await run(write.value, read.value) }
  } catch (error) {
    result = { ok: false, error }
  }
  const cleanup = await Promise.allSettled(
    reserved.map(async ({ owner, connection }) => {
      await release(owner, connection)
    })
  )
  const failedCleanup = cleanup.filter(value => value.status === 'rejected')
  if (failedCleanup.length) {
    const errors = failedCleanup.map(value => value.reason)
    if (!result.ok) errors.unshift(result.error)
    throw new SnapshotJournalConnectionCleanupError(
      new AggregateError(errors, 'Snapshot connection ownership did not drain')
    )
  }
  if (!result.ok) throw result.error
  return result.value
}
