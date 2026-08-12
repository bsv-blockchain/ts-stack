import { Collection, CreateIndexesOptions, IndexSpecification } from 'mongodb'

/** The collection surface the index initializer needs. */
type IndexableCollection = Pick<Collection<any>, 'createIndex' | 'aggregate' | 'deleteOne'>

/**
 * One index a storage manager wants to exist.
 *
 * `label` only appears in the failure log, so name it after the index, not the field list.
 */
export interface IndexDefinition {
  label: string
  collection: IndexableCollection
  /**
   * Mongo index keys. Widened past `IndexSpecification` because a heterogeneous array of
   * key literals infers a union whose members carry `?: undefined` properties, which the
   * stricter type rejects; the cast at the call site is checked by Mongo at runtime.
   */
  keys: IndexSpecification | Record<string, unknown>
  options?: CreateIndexesOptions
}

/** Environment variable that opts a deployment into deleting duplicate rows. */
export const INDEX_REPAIR_ENV = 'OVERLAY_INDEX_REPAIR'

const repairEnabled = (): boolean => {
  const value = process.env[INDEX_REPAIR_ENV]
  return value === 'true' || value === '1'
}

const isDuplicateKeyError = (error: unknown): boolean => {
  const candidate = error as { code?: unknown, message?: unknown } | null
  if (candidate?.code === 11000) return true
  return typeof candidate?.message === 'string' && candidate.message.includes('E11000')
}

/** Oldest row wins. A row with no createdAt sorts last, so it is treated as the extra. */
const oldestFirst = (a: { createdAt?: Date }, b: { createdAt?: Date }): number => {
  const at = a.createdAt instanceof Date ? a.createdAt.getTime() : Number.MAX_SAFE_INTEGER
  const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : Number.MAX_SAFE_INTEGER
  return at - bt
}

/**
 * Lazily builds a storage manager's indexes, once, without letting a build failure take
 * the collection's reads down with it.
 *
 * A unique index cannot be built over a collection that already holds rows violating it,
 * and overlay collections predate several of the unique indexes declared here. Awaiting a
 * single all-or-nothing `Promise.all` before every read turned that into a total outage of
 * the lookup service (`E11000 duplicate key error` on every query), and caching the
 * rejected promise made the outage permanent for the life of the process.
 *
 * So: each index is attempted independently, a failure is logged and skipped, and a run
 * with any failure is not remembered — the next call retries, so a repaired collection
 * recovers in place without a restart. Queries then run against whatever indexes exist,
 * which is slower than intended but correct.
 *
 * A deployment that sets `OVERLAY_INDEX_REPAIR=true` additionally repairs the data behind a
 * failed *unique* build: the duplicate rows are removed, oldest kept, and the build is
 * retried. That deletes rows, so it is opt-in and never the default.
 */
export class CollectionIndexes {
  private pending?: Promise<void>

  constructor (
    private readonly owner: string,
    private readonly definitions: () => IndexDefinition[]
  ) {}

  async ensure (): Promise<void> {
    this.pending ??= (async () => {
      const outcomes = await Promise.all(this.definitions().map(async d => await this.build(d)))
      if (outcomes.includes(false)) this.pending = undefined
    })()
    return await this.pending
  }

  private async build (definition: IndexDefinition): Promise<boolean> {
    try {
      await definition.collection.createIndex(
        definition.keys as IndexSpecification,
        definition.options ?? {}
      )
      return true
    } catch (error) {
      console.error(
        `${this.owner}: failed to create index ${definition.label}; continuing without it`,
        error
      )
      return await this.repairAndRetry(definition, error)
    }
  }

  /**
   * Remove the rows that make a unique index unbuildable, then build it again. Only runs
   * for a unique index whose build failed on a duplicate key, and only when the deployment
   * has opted in.
   */
  private async repairAndRetry (definition: IndexDefinition, error: unknown): Promise<boolean> {
    if (definition.options?.unique !== true) return false
    if (!isDuplicateKeyError(error)) return false
    if (!repairEnabled()) {
      console.error(
        `${this.owner}: ${definition.label} is unbuildable while duplicate rows exist; ` +
          `set ${INDEX_REPAIR_ENV}=true to delete the duplicates automatically`
      )
      return false
    }

    const fields = Object.keys(definition.keys as Record<string, unknown>)
    if (fields.length === 0) return false

    try {
      const key: Record<string, string> = {}
      fields.forEach((field, position) => {
        key[`f${position}`] = `$${field}`
      })
      const groups = (await definition.collection
        .aggregate(
          [
            { $group: { _id: key, n: { $sum: 1 }, docs: { $push: { id: '$_id', createdAt: '$createdAt' } } } },
            { $match: { n: { $gt: 1 } } }
          ],
          { allowDiskUse: true }
        )
        .toArray()) as Array<{ docs: Array<{ id: unknown, createdAt?: Date }> }>

      let deleted = 0
      for (const group of groups) {
        const [, ...extras] = [...group.docs].sort(oldestFirst)
        for (const extra of extras) {
          await definition.collection.deleteOne({ _id: extra.id } as any)
          deleted++
        }
      }
      console.error(
        `${this.owner}: ${INDEX_REPAIR_ENV} removed ${deleted} duplicate row(s) across ` +
          `${groups.length} key(s) for ${definition.label}; rebuilding`
      )

      await definition.collection.createIndex(
        definition.keys as IndexSpecification,
        definition.options ?? {}
      )
      return true
    } catch (repairError) {
      console.error(`${this.owner}: repair of ${definition.label} failed`, repairError)
      return false
    }
  }
}
