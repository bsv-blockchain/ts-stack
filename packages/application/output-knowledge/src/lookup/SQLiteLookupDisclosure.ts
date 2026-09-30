import {
  canonicalOutputJSON,
  incrementOutputU64,
  outputHex32,
  outputString,
  outputU64,
  OutputProtocolError
} from '@bsv/sdk'
import type { LookupDisclosureGuard, LookupSessionOpening } from './LookupSessionCodec.js'
import type {
  LookupSessionAuthorization,
  LookupSessionCapacity,
  LookupDisclosureState
} from './LookupSessionStorage.js'
import type { SQLiteLookupSessionRecords } from './SQLiteLookupSessionRecords.js'
import { decimal, position } from './SQLiteLookupEncoding.js'

/** All callers execute inside the session owner's serialization transaction. */
export class SQLiteLookupDisclosure {
  constructor(
    private readonly records: SQLiteLookupSessionRecords,
    private readonly capacity: Readonly<LookupSessionCapacity>
  ) {}

  private digest(id: string, state: LookupDisclosureState): string {
    return this.records.digest('guard', id, canonicalOutputJSON(state))
  }

  state(id: string): LookupDisclosureState {
    outputString(id)
    const { database, namespace } = this.records.bridge
    const row = database
      .prepare(
        `SELECT CASE WHEN length(revision)=16 THEN revision END AS revision,
      blocked, CASE WHEN operation IS NULL OR length(operation)=64 THEN operation ELSE 'invalid' END AS operation,
      CASE WHEN length(digest)=64 THEN digest END AS digest FROM output_lookup_guards
      WHERE namespace=? AND guard_id=?`
      )
      .get(namespace, id)
    if (!row) throw new OutputProtocolError('reset-required', 'Lookup disclosure guard is missing')
    if (
      (row.blocked !== 0 && row.blocked !== 1) ||
      (row.operation !== null &&
        (typeof row.operation !== 'string' || !/^[0-9a-f]{64}$/.test(row.operation)))
    )
      throw new OutputProtocolError('reset-required', 'Invalid lookup disclosure guard state')
    const state = {
      revision: decimal(row.revision),
      blocked: row.blocked === 1,
      operation: row.operation as string | null
    }
    if ((state.blocked && state.operation === null) || row.digest !== this.digest(id, state))
      throw new OutputProtocolError('reset-required', 'Lookup disclosure guard integrity failed')
    return state
  }

  guard(id: string): string {
    return this.state(id).revision
  }

  private save(id: string, state: LookupDisclosureState): void {
    this.records.bridge.database
      .prepare(
        'UPDATE output_lookup_guards SET revision=?,blocked=?,operation=?,digest=? WHERE namespace=? AND guard_id=?'
      )
      .run(
        position(state.revision),
        state.blocked ? 1 : 0,
        state.operation,
        this.digest(id, state),
        this.records.bridge.namespace,
        id
      )
  }

  initialize(id: string): string {
    outputString(id)
    const { database, namespace } = this.records.bridge
    if (
      database
        .prepare('SELECT 1 FROM output_lookup_guards WHERE namespace=? AND guard_id=?')
        .get(namespace, id)
    )
      return this.guard(id)
    if (this.records.metadata().guards >= this.capacity.guards)
      throw new OutputProtocolError('limited', 'Lookup disclosure guard capacity is full')
    database
      .prepare('INSERT INTO output_lookup_guards VALUES (?,?,?,?,?,?)')
      .run(
        namespace,
        id,
        position('0'),
        0,
        null,
        this.digest(id, { revision: '0', blocked: false, operation: null })
      )
    database
      .prepare('UPDATE output_lookup_session_meta SET guards=guards+1 WHERE namespace=?')
      .run(namespace)
    return '0'
  }

  advance(id: string, expected: string): string {
    outputU64(expected)
    const current = this.state(id)
    if (current.revision !== expected || current.blocked)
      throw new OutputProtocolError('conflict', 'Lookup disclosure guard changed or is blocked')
    const revision = incrementOutputU64(expected)
    this.save(id, { revision, blocked: false, operation: null })
    return revision
  }

  transition(id: string, expected: string, operation: string, blocked: boolean): string {
    outputU64(expected)
    outputHex32(operation)
    const revision = incrementOutputU64(expected)
    const current = this.state(id)
    if (
      current.revision === revision &&
      current.blocked === blocked &&
      current.operation === operation
    )
      return revision
    if (
      current.revision !== expected ||
      current.blocked === blocked ||
      (!blocked && current.operation !== operation)
    )
      throw new OutputProtocolError(
        'conflict',
        'Lookup disclosure transition lost its operation or revision'
      )
    this.save(id, { revision, blocked, operation })
    return revision
  }

  check(guards: LookupDisclosureGuard[]): void {
    for (const premise of guards) {
      const current = this.state(premise.id)
      if (current.revision !== premise.revision || current.blocked)
        throw new OutputProtocolError(premise.failure, 'Lookup disclosure premise changed')
    }
  }

  authorize(
    opening: Pick<LookupSessionOpening, 'principal' | 'access' | 'guards'>,
    authorization: LookupSessionAuthorization
  ): void {
    if (opening.principal !== authorization.principal || opening.access !== authorization.access)
      throw new OutputProtocolError('unauthorized', 'Lookup authorization partition changed')
    if (authorization.guards.length !== opening.guards.length)
      throw new OutputProtocolError('unauthorized', 'Lookup authorization premises changed')
    for (const original of opening.guards) {
      const current = authorization.guards.find(value => value.id === original.id)
      if (
        !current ||
        current.revision !== original.revision ||
        current.failure !== original.failure
      )
        throw new OutputProtocolError(original.failure, 'Lookup authorization premise changed')
    }
    this.check(opening.guards)
  }
}
