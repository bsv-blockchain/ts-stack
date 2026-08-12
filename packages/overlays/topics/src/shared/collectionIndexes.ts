import { Collection, CreateIndexesOptions, IndexSpecification } from 'mongodb'

/**
 * One index a storage manager wants to exist.
 *
 * `label` only appears in the failure log, so name it after the index, not the field list.
 */
export interface IndexDefinition {
  label: string
  collection: Pick<Collection<any>, 'createIndex'>
  /**
   * Mongo index keys. Widened past `IndexSpecification` because a heterogeneous array of
   * key literals infers a union whose members carry `?: undefined` properties, which the
   * stricter type rejects; the cast at the call site is checked by Mongo at runtime.
   */
  keys: IndexSpecification | Record<string, unknown>
  options?: CreateIndexesOptions
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
 */
export class CollectionIndexes {
  private pending?: Promise<void>

  constructor (
    private readonly owner: string,
    private readonly definitions: () => IndexDefinition[]
  ) {}

  async ensure (): Promise<void> {
    this.pending ??= (async () => {
      const outcomes = await Promise.all(
        this.definitions().map(async definition => {
          try {
            await definition.collection.createIndex(definition.keys as IndexSpecification, definition.options ?? {})
            return true
          } catch (error) {
            console.error(
              `${this.owner}: failed to create index ${definition.label}; continuing without it`,
              error
            )
            return false
          }
        })
      )
      if (outcomes.includes(false)) this.pending = undefined
    })()
    return await this.pending
  }
}
