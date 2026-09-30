import { canonicalOutputJSON, OutputProtocolError } from '@bsv/sdk'
import type { SQLiteLookupBridge } from './SQLiteLookupBridge.js'
import type { LookupSessionCapacity } from './LookupSessionStorage.js'
import { position } from './SQLiteLookupEncoding.js'

const maxima: Readonly<LookupSessionCapacity> = Object.freeze({
  epochs: 64,
  guards: 1024,
  fences: 65536,
  sessions: 65536,
  sessionsPerPrincipal: 256,
  bytes: 268435456
})

export function lookupSessionCapacity(
  input: Partial<LookupSessionCapacity> = {}
): Readonly<LookupSessionCapacity> {
  const result = { ...maxima, ...input }
  for (const key of Object.keys(result) as (keyof LookupSessionCapacity)[])
    if (
      !Object.hasOwn(maxima, key) ||
      !Number.isSafeInteger(result[key]) ||
      result[key] < 1 ||
      result[key] > maxima[key]
    )
      throw new OutputProtocolError('invalid', 'Invalid lookup session capacity')
  return Object.freeze(result)
}

export function sessionConfiguration(capacity: Readonly<LookupSessionCapacity>): string {
  return canonicalOutputJSON({ format: 'output-lookup-sessions/1', capacity })
}

export function initializeLookupSessions(bridge: SQLiteLookupBridge, configuration: string): void {
  const { database, namespace } = bridge
  bridge.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS output_lookup_session_meta (
        namespace TEXT PRIMARY KEY, configuration TEXT NOT NULL, clock TEXT NOT NULL,
        epochs INTEGER NOT NULL, guards INTEGER NOT NULL, fences INTEGER NOT NULL,
        sessions INTEGER NOT NULL, payload_bytes INTEGER NOT NULL,
        FOREIGN KEY(namespace) REFERENCES output_lookup_meta(namespace)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS output_lookup_epochs (
        namespace TEXT NOT NULL, epoch TEXT NOT NULL, secret TEXT NOT NULL,
        accepts_new INTEGER NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(namespace,epoch),
        FOREIGN KEY(namespace) REFERENCES output_lookup_session_meta(namespace)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS output_lookup_guards (
        namespace TEXT NOT NULL, guard_id TEXT NOT NULL, revision TEXT NOT NULL,
        blocked INTEGER NOT NULL, operation TEXT,
        digest TEXT NOT NULL, PRIMARY KEY(namespace,guard_id),
        FOREIGN KEY(namespace) REFERENCES output_lookup_session_meta(namespace)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS output_lookup_openings (
        namespace TEXT NOT NULL, epoch TEXT NOT NULL, opening_key TEXT NOT NULL,
        request_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL, principal_key TEXT NOT NULL,
        session TEXT NOT NULL, expires_at TEXT NOT NULL, replay_until TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('open','closed','expired')), digest TEXT NOT NULL,
        PRIMARY KEY(namespace,epoch,opening_key), UNIQUE(namespace,session),
        FOREIGN KEY(namespace,epoch) REFERENCES output_lookup_epochs(namespace,epoch)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS output_lookup_opening_principals
        ON output_lookup_openings(namespace,principal_key);
      CREATE TABLE IF NOT EXISTS output_lookup_sessions (
        namespace TEXT NOT NULL, session TEXT NOT NULL, replay_until TEXT NOT NULL,
        metadata TEXT NOT NULL, original_open TEXT NOT NULL, contract TEXT NOT NULL,
        first_batch TEXT NOT NULL, header TEXT NOT NULL, header_digest TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(namespace,session),
        FOREIGN KEY(namespace,session) REFERENCES output_lookup_openings(namespace,session)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS output_lookup_session_expiry
        ON output_lookup_sessions(namespace,replay_until,session);
    `)
    if (
      database.prepare('SELECT 1 FROM output_lookup_session_meta WHERE namespace=?').get(namespace)
    )
      throw new OutputProtocolError('conflict', 'Lookup session namespace already exists')
    database
      .prepare('INSERT INTO output_lookup_session_meta VALUES (?,?,?,0,0,0,0,0)')
      .run(namespace, configuration, position('0'))
  })
}
