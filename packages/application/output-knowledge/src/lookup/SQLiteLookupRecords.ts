import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalOutputJSON,
  Hash,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  Utils
} from '@bsv/sdk'
import type { LookupIndexCodec, LookupIndexGroup, LookupIndexRow } from './LookupIndexCodec.js'
import { bytes, decimal, position } from './SQLiteLookupEncoding.js'

interface StoredKey {
  first: string
  current: string
  expiresAt: string | null
}
export interface SQLiteLookupVersion {
  key: string
  payload: string
  expiresAt: string | null
  previous: StoredKey | undefined
}

/** Internal record I/O. The owning adapter supplies one transaction for every operation. */
export class SQLiteLookupRecords {
  constructor(
    private readonly database: DatabaseSync,
    private readonly namespace: string,
    private readonly codec: LookupIndexCodec
  ) {}

  private key(key: string, head: string): StoredKey | undefined {
    const record = this.database
      .prepare(
        `SELECT
      CASE WHEN length(first_sequence)=16 THEN first_sequence END AS first_sequence,
      CASE WHEN length(current_sequence)=16 THEN current_sequence END AS current_sequence,
      CASE WHEN expires_at IS NULL OR length(expires_at)=16 THEN expires_at ELSE '' END AS expires_at,
      CASE WHEN length(head_digest)=64 THEN head_digest END AS head_digest
      FROM output_lookup_keys WHERE namespace=? AND row_key=?`
      )
      .get(this.namespace, key)
    if (record === undefined) return undefined
    const result: StoredKey = {
      first: decimal(record.first_sequence),
      current: decimal(record.current_sequence),
      expiresAt: record.expires_at === null ? null : decimal(record.expires_at)
    }
    if (
      outputU64(result.first) === 0n ||
      outputU64(result.first) > outputU64(result.current) ||
      outputU64(result.current) > outputU64(head) ||
      record.head_digest !== this.digest('key', key, canonicalOutputJSON(result))
    )
      throw new OutputProtocolError('reset-required', 'Lookup key lost its head binding')
    return result
  }

  row(key: string, at: string, head: string): LookupIndexRow | null {
    const known = this.key(key, head)
    if (known === undefined || outputU64(known.first) > outputU64(at)) return null
    const record = this.database
      .prepare(
        `SELECT CASE WHEN length(sequence)=16 THEN sequence END AS sequence,
      CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload END AS payload,payload_bytes,
      CASE WHEN length(digest)=64 THEN digest END AS digest,
      CASE WHEN next_sequence IS NULL OR length(next_sequence)=16 THEN next_sequence ELSE '' END AS next_sequence,
      CASE WHEN length(link_digest)=64 THEN link_digest END AS link_digest
      FROM output_lookup_versions WHERE namespace=? AND row_key=? AND sequence<=? ORDER BY sequence DESC LIMIT 1`
      )
      .get(this.codec.limits.rowBytes, this.namespace, key, position(at))
    if (record === undefined)
      throw new OutputProtocolError('reset-required', 'Lookup row lost its retained version')
    const revision = decimal(record.sequence)
    this.checkLink(record, key, revision, at, known)
    const value = this.payload(record, this.codec.limits.rowBytes, 'row', key + ':' + revision)
    if (value === null) return null
    const row = this.codec.row(value)
    if (
      row.key !== key ||
      row.revision !== revision ||
      (revision === known.current && row.value.expiresAt !== known.expiresAt)
    )
      throw new OutputProtocolError('reset-required', 'Lookup row version binding changed')
    return row
  }

  private checkLink(
    record: Record<string, unknown>,
    key: string,
    revision: string,
    at: string,
    known: StoredKey
  ): void {
    const next = record.next_sequence === null ? null : decimal(record.next_sequence)
    if (
      outputU64(revision) < outputU64(known.first) ||
      record.link_digest !== this.digest('link', key + ':' + revision, canonicalOutputJSON(next))
    )
      throw new OutputProtocolError('reset-required', 'Lookup row lost its history binding')
    if (next === null) {
      if (revision !== known.current)
        throw new OutputProtocolError('reset-required', 'Lookup row lost its current version')
    } else if (outputU64(next) <= outputU64(at) || outputU64(next) > outputU64(known.current)) {
      // If the successor were still present at/before W, the latest-at-W query
      // would have selected it. Never silently fall back after a missing version.
      throw new OutputProtocolError('reset-required', 'Lookup row lost a promised history interval')
    }
  }

  prepare(group: LookupIndexGroup, head: string): SQLiteLookupVersion[] {
    return group.changes.map(change => ({
      key: change.key,
      payload: canonicalOutputJSON(change.after, { bytes: this.codec.limits.rowBytes }),
      expiresAt: change.after?.value.expiresAt ?? null,
      previous: this.key(change.key, head)
    }))
  }

  write(sequence: string, versions: readonly SQLiteLookupVersion[]): void {
    for (const version of versions) {
      this.writeHead(sequence, version)
      this.database
        .prepare('INSERT INTO output_lookup_versions VALUES (?,?,?,?,?,?,NULL,?)')
        .run(
          this.namespace,
          version.key,
          position(sequence),
          version.payload,
          bytes(version.payload),
          this.digest('row', version.key + ':' + sequence, version.payload),
          this.digest('link', version.key + ':' + sequence, 'null')
        )
    }
  }

  private writeHead(sequence: string, version: SQLiteLookupVersion): void {
    const head: StoredKey = {
      first: version.previous?.first ?? sequence,
      current: sequence,
      expiresAt: version.expiresAt
    }
    const digest = this.digest('key', version.key, canonicalOutputJSON(head))
    const expiry = version.expiresAt === null ? null : position(version.expiresAt)
    if (version.previous === undefined) {
      this.database
        .prepare('INSERT INTO output_lookup_keys VALUES (?,?,?,?,?,?)')
        .run(this.namespace, version.key, position(head.first), position(sequence), expiry, digest)
      return
    }
    const linked = this.database
      .prepare(
        `UPDATE output_lookup_versions SET next_sequence=?,link_digest=?
      WHERE namespace=? AND row_key=? AND sequence=? AND next_sequence IS NULL`
      )
      .run(
        position(sequence),
        this.digest(
          'link',
          version.key + ':' + version.previous.current,
          canonicalOutputJSON(sequence)
        ),
        this.namespace,
        version.key,
        position(version.previous.current)
      )
    if (linked.changes !== 1)
      throw new OutputProtocolError('reset-required', 'Lookup write lost its current version link')
    this.database
      .prepare(
        'UPDATE output_lookup_keys SET current_sequence=?,expires_at=?,head_digest=? WHERE namespace=? AND row_key=?'
      )
      .run(position(sequence), expiry, digest, this.namespace, version.key)
  }
  digest(kind: string, identity: string, payload: string): string {
    return Utils.toHex(
      Hash.sha256(
        Utils.toArray(
          canonicalOutputJSON({
            format: 'output-lookup-record/1',
            namespace: this.namespace,
            kind,
            identity
          }) +
            '\0' +
            payload,
          'utf8'
        )
      )
    )
  }
  private payload(
    record: Record<string, unknown>,
    maximum: number,
    kind: string,
    identity: string
  ): unknown {
    if (
      typeof record.payload !== 'string' ||
      bytes(record.payload) !== record.payload_bytes ||
      record.digest !== this.digest(kind, identity, record.payload)
    )
      throw new OutputProtocolError('reset-required', 'Invalid lookup index record integrity')
    return parseOutputJSON(record.payload, { bytes: maximum })
  }

  group(sequence: string): { group: LookupIndexGroup; key: string } {
    const record = this.database
      .prepare(
        `SELECT CASE WHEN length(mutation_key)=64 THEN mutation_key END AS mutation_key,
      CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload END AS payload,payload_bytes,
      CASE WHEN length(digest)=64 THEN digest END AS digest
      FROM output_lookup_groups WHERE namespace=? AND sequence=?`
      )
      .get(this.codec.limits.groupBytes, this.namespace, position(sequence))
    if (record === undefined)
      throw new OutputProtocolError('reset-required', 'Lookup group lost its retained history')
    const group = this.codec.group(
      this.payload(record, this.codec.limits.groupBytes, 'group', sequence)
    )
    const key = this.codec.mutationKey(this.codec.original(group))
    if (group.sequence !== sequence || record.mutation_key !== key)
      throw new OutputProtocolError('reset-required', 'Lookup group binding changed')
    return { group, key }
  }
}
