import type { Knex } from 'knex'
import { Brc38NodeJsonIndex } from './Brc38NodeJsonIndex'
import { loadBrc38ImportIdMap, type Brc38ImportMapScope } from './Brc38ImportIdMap'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import { requireBrc38StructuredProjectionRead } from './Brc38PublishedStructuredSourceNode'
import {
  Brc38StreamedNotifyProjection,
  type Brc38StreamedNotifyProjectionPolicy as Brc38PortableNotifyProjectionPolicy
} from './Brc38StreamedNotifyProjection'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import type { Brc38StreamedStructured } from './Brc38StructuredJson'

export interface Brc38StreamedNotifyProjectionPolicy extends Omit<
  Brc38PortableNotifyProjectionPolicy,
  'maximumTemporaryIndexBytes'
> {
  readonly privateParent: string
  readonly maximumTemporaryFileBytes: number
}
/** Existing actual native entry point, adapting owned read/index factories to
 * the portable projection. Export/signature and signed local-ID behavior stay
 * unchanged. Derived spans/mappings are DATA; current native checks remain. */
export class Brc38StreamedNotifyProjectionNode {
  readonly unmappedIds: number
  readonly mappedIncomingIds: number
  private constructor(private readonly inner: Brc38StreamedNotifyProjection) {
    this.unmappedIds = inner.unmappedIds
    this.mappedIncomingIds = inner.mappedIncomingIds
  }
  static async prepare(
    trx: Knex.Transaction,
    selectedScope: Brc38ImportMapScope,
    source: Brc38StreamedStructured,
    selected: Brc38StreamedNotifyProjectionPolicy,
    existingSource?: Brc38StreamedStructured
  ): Promise<Brc38StreamedNotifyProjectionNode> {
    const scope = Object.freeze({ ...selectedScope }),
      original = Object.freeze({ ...selected }),
      owners: Brc38StructuredProjectionOwners = Object.freeze({
        check: () => {
          requireBrc38ImportSqliteTransaction(trx)
          requireBrc38StructuredProjectionRead(trx)
        },
        openIndex: async (policy: Parameters<Brc38StructuredProjectionOwners['openIndex']>[0]) =>
          await Brc38NodeJsonIndex.open({
            ...policy,
            privateParent: original.privateParent,
            maximumTemporaryFileBytes: policy.maximumTemporaryIndexBytes
          }),
        readMappings: async (
          entity: Parameters<Brc38StructuredProjectionOwners['readMappings']>[0],
          values: readonly number[]
        ) => {
          const loaded = await loadBrc38ImportIdMap(
            trx,
            scope,
            values.map(incomingId => ({ entity, incomingId, required: false }))
          )
          return values.map(id =>
            Object.hasOwn(loaded.map[entity].idMap, id) ? loaded.map[entity].idMap[id] : undefined
          )
        }
      }),
      policy = { ...original, maximumTemporaryIndexBytes: original.maximumTemporaryFileBytes }
    return new Brc38StreamedNotifyProjectionNode(
      await Brc38StreamedNotifyProjection.prepare(owners, source, policy, existingSource)
    )
  }
  chunks(maximumChunkBytes = 65536): AsyncGenerator<Uint8Array> {
    return this.inner.chunks(maximumChunkBytes)
  }
  async close(): Promise<void> {
    await this.inner.close()
  }
}
