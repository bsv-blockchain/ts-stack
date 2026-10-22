import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import {
  rewriteBrc38StructuredJsonMembers,
  type Brc38StructuredMemberEdit,
  type Brc38StructuredJsonPolicy,
  type Brc38StreamedStructured
} from './Brc38StructuredJson'
import { brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

type Entity = keyof SyncMap
export interface Brc38CheckpointSyncMapDelta {
  readonly entity?: Entity
  readonly count: number
  readonly mappings: readonly Readonly<{ incomingId: number; localId: number }>[]
  readonly maximumUpdatedAt?: Date
  readonly done: boolean
}
export type Brc38CheckpointSyncMapDeltas = Brc38CheckpointSyncMapDelta | readonly Brc38CheckpointSyncMapDelta[]
export interface Brc38CheckpointSyncMapPolicy extends Brc38StructuredJsonPolicy {
  readonly maximumDateCodeUnits: number
}
interface Entry {
  object: boolean
  countSeen: boolean
  mapSeen: boolean
  count: number
  maximum?: string
  increment: number
  priorIncrement: number
  replacements: Map<string, number>
  suppliedMaximum?: string
  changed: boolean
}
const names = Object.freeze(Object.keys(createSyncMap()) as Entity[])
function invalid(): never {
  throw new Error('Operational checkpoint sync map differs from its complete current state or finite delta')
}

/** Stream a CURRENT operational map, preserving every unknown member and
 * every existing ID mapping. This is a codec, never row/source/writer/primary
 * admission. Output must remain private until EOF and index cleanup. The caller
 * supplies actual planned IDs and independently rechecks them in its final
 * atomic row/map/provenance/checkpoint/receipt transaction. */
export async function* checkpointBrc38SyncMap(
  selectedSource: Brc38StreamedStructured,
  selectedPolicy: Brc38CheckpointSyncMapPolicy,
  selectedDelta: Brc38CheckpointSyncMapDeltas
): AsyncGenerator<Uint8Array, Readonly<{ maximumUpdatedAt?: string }>> {
  const policy = Object.freeze({ ...selectedPolicy }),
    working = brc38WorkingAllocation(policy.workingAllocation)
  const deltas: readonly Brc38CheckpointSyncMapDelta[] = Array.isArray(selectedDelta)
    ? selectedDelta
    : [selectedDelta as Brc38CheckpointSyncMapDelta]
  if (
    deltas.length < 1 ||
    deltas.length > 128 ||
    !Number.isSafeInteger(policy.maximumDateCodeUnits) ||
    policy.maximumDateCodeUnits < 24 ||
    policy.maximumDateCodeUnits > 8192
  )
    invalid()
  let mappingCount = 0
  for (const delta of deltas) {
    if (
      !Array.isArray(delta.mappings) ||
      delta.mappings.length > 4000 ||
      !Number.isSafeInteger(delta.count) ||
      delta.count < 0 ||
      typeof delta.done !== 'boolean' ||
      (delta.entity !== undefined && !names.includes(delta.entity)) ||
      (delta.entity === undefined &&
        (delta.count !== 0 || delta.mappings.length !== 0 || delta.maximumUpdatedAt !== undefined))
    )
      invalid()
    mappingCount += delta.mappings.length
    if (mappingCount > 4000) invalid()
  }
  const reservation = working?.claim(32768 + 4096 * mappingCount + 1024 * (deltas.length - 1))
  let dateCharge: Brc38WorkingCharge | undefined
  try {
    const entries = new Map<Entity, Entry>(
        names.map(name => [
          name,
          {
            object: false,
            countSeen: false,
            mapSeen: false,
            count: 0,
            increment: 0,
            priorIncrement: 0,
            replacements: new Map(),
            changed: false
          }
        ])
      ),
      edits: Brc38StructuredMemberEdit[] = []
    let reset = false
    for (const delta of deltas) {
      if (delta.entity !== undefined) {
        const entry = entries.get(delta.entity)!,
          pageKeys = new Set<string>()
        entry.changed = true
        entry.increment += delta.count
        if (!Number.isSafeInteger(entry.increment)) invalid()
        if (!reset) entry.priorIncrement = entry.increment
        if (delta.maximumUpdatedAt !== undefined) {
          const supplied = delta.maximumUpdatedAt.toISOString()
          if (entry.suppliedMaximum === undefined || supplied > entry.suppliedMaximum) entry.suppliedMaximum = supplied
        }
        for (const value of delta.mappings) {
          if (!Number.isInteger(value.incomingId) || !Number.isSafeInteger(value.localId) || value.localId < 1)
            invalid()
          const key = String(value.incomingId)
          if (pageKeys.has(key) || (entry.replacements.has(key) && entry.replacements.get(key) !== value.localId))
            invalid()
          pageKeys.add(key)
          entry.replacements.set(key, value.localId)
        }
      }
      if (delta.done) {
        reset = true
        for (const entry of entries.values()) entry.increment = 0
      }
    }
    for (const [entity, entry] of entries)
      for (const [key, localId] of entry.replacements)
        edits.push({ path: [entity, 'idMap'], key, value: () => localId })
    const selectedEntry = (path: readonly (string | number)[]): Entry | undefined =>
      typeof path[0] === 'string' ? entries.get(path[0] as Entity) : undefined
    for (const name of names) {
      const entry = entries.get(name)!
      if (reset || entry.changed)
        edits.push({
          path: [name],
          key: 'count',
          value: () => {
            if (!entry.countSeen || !Number.isSafeInteger(entry.count + entry.priorIncrement)) invalid()
            return reset ? entry.increment : entry.count + entry.increment
          }
        })
      const supplied = entry.suppliedMaximum
      edits.push({
        path: [name],
        key: 'maxUpdated_at',
        existingOnly: supplied === undefined,
        value: () => {
          if (entry.maximum === undefined && supplied === undefined) invalid()
          return supplied === undefined || (entry.maximum !== undefined && entry.maximum > supplied)
            ? entry.maximum!
            : supplied
        }
      })
    }
    let date = '',
      dateEntity: Entity | undefined,
      root = false
    yield* rewriteBrc38StructuredJsonMembers(selectedSource, policy, edits, {
      enter: (path, kind) => {
        policy.signal?.throwIfAborted()
        if (path.length === 0) {
          if (kind !== 'object') invalid()
          root = true
          return
        }
        const entry = selectedEntry(path)
        if (entry === undefined) return
        if (path.length === 1) {
          if (kind !== 'object') invalid()
          entry.object = true
        }
        if (!entry.object) invalid()
        if (
          (path.length === 2 && path[1] === 'count' && kind !== 'number') ||
          (path.length === 2 && path[1] === 'idMap' && kind !== 'object') ||
          (path.length === 3 && path[1] === 'idMap' && kind !== 'number')
        )
          invalid()
        if (path.length === 2 && path[1] === 'idMap') entry.mapSeen = true
        if (path.length === 2 && path[1] === 'maxUpdated_at') {
          if (kind !== 'string') invalid()
          date = ''
          dateEntity = path[0] as Entity
          dateCharge?.close()
          dateCharge = undefined
        }
      },
      text: (path, value) => {
        if (path.length !== 2 || path[0] !== dateEntity || path[1] !== 'maxUpdated_at') return
        if (value.length > policy.maximumDateCodeUnits - date.length)
          throw new SnapshotResourceLimitError('Current sync-map date exceeds its explicit scalar allocation')
        const bytes = 1024 + 16 * (date.length + value.length)
        if (dateCharge === undefined) dateCharge = working?.claim(bytes)
        else dateCharge.resize(bytes)
        date += value
      },
      number: (path, value) => {
        const entry = selectedEntry(path)
        if (entry === undefined) return
        if (path.length === 2 && path[1] === 'count') {
          if (!Number.isSafeInteger(value) || value < 0) invalid()
          entry.count = value
          entry.countSeen = true
        }
        if (path.length === 3 && path[1] === 'idMap') {
          if (!Number.isSafeInteger(value)) invalid()
          if (
            typeof path[2] === 'string' &&
            entry.replacements.has(path[2]) &&
            entry.replacements.get(path[2]) !== value
          )
            invalid()
        }
      },
      end: path => {
        if (path.length !== 2 || path[0] !== dateEntity || path[1] !== 'maxUpdated_at') return
        const when = new Date(date)
        if (!Number.isFinite(when.getTime())) invalid()
        entries.get(dateEntity!)!.maximum = when.toISOString()
        date = ''
        dateEntity = undefined
        dateCharge?.close()
        dateCharge = undefined
      }
    })
    if (!root || [...entries.values()].some(entry => !entry.object || !entry.countSeen || !entry.mapSeen)) invalid()
    for (const entry of entries.values())
      if (entry.suppliedMaximum !== undefined && (entry.maximum === undefined || entry.maximum < entry.suppliedMaximum))
        entry.maximum = entry.suppliedMaximum
    let maximumUpdatedAt: string | undefined
    for (const entry of entries.values())
      if (entry.maximum !== undefined && (maximumUpdatedAt === undefined || entry.maximum > maximumUpdatedAt))
        maximumUpdatedAt = entry.maximum
    return Object.freeze(maximumUpdatedAt === undefined ? {} : { maximumUpdatedAt })
  } finally {
    dateCharge?.close()
    reservation?.close()
  }
}
