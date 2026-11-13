import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalOutputJSON, type OutputJSONObject } from '@bsv/sdk'
import { codec, configuration, type fixture } from './protected-ledger-fixture.js'

type Fixture = ReturnType<typeof fixture>
const binding = (kind: string, fields: OutputJSONObject): OutputJSONObject => ({
  format: 'output-protected-ledger/1',
  storeId: configuration.storeId,
  configuration: createHash('sha256').update(canonicalOutputJSON(configuration)).digest('hex'),
  kind,
  ...fields
})

/** Synthetic custody-authorized restoration. This deliberately bypasses the writer
 * to establish that authenticated storage still checks the restored semantics. */
export function restoreHead(f: Fixture, edit: (head: OutputJSONObject) => void): void {
  const db = new DatabaseSync(f.path)
  try {
    const row = db.prepare('SELECT revision,envelope FROM protected_head').get()!
    const context = binding('head', { revision: String(row.revision) })
    const bytes = codec().open(context, JSON.parse(String(row.envelope)))
    const head = JSON.parse(Buffer.from(bytes).toString('utf8')) as OutputJSONObject
    edit(head)
    const envelope = codec().seal(context, Buffer.from(canonicalOutputJSON(head)))
    db.prepare('UPDATE protected_head SET envelope=?').run(canonicalOutputJSON(envelope))
  } finally {
    db.close()
  }
}

export function restoreRecord(
  f: Fixture,
  plaintext: Uint8Array,
  overrides?: { revision?: string; bytes?: number; envelope?: string }
): void {
  const db = new DatabaseSync(f.path)
  const changes = overrides ?? {}
  let inventory: string
  try {
    const row = db.prepare('SELECT * FROM protected_records').get()!
    const revision = changes.revision ?? String(row.revision)
    const bytes = changes.bytes ?? plaintext.byteLength
    const context = binding('record', {
      recordKind: String(row.kind),
      key: String(row.key),
      revision,
      reservedBytes: Number(row.reserved_bytes),
      reservedUpdates: Number(row.reserved_updates),
      bytes
    })
    const envelope = changes.envelope ?? canonicalOutputJSON(codec().seal(context, plaintext))
    const digest = createHash('sha256').update(envelope).digest('hex')
    db.prepare('UPDATE protected_records SET revision=?,bytes=?,envelope=?,sealed_digest=?').run(
      revision,
      bytes,
      envelope,
      digest
    )
    const hash = createHash('sha256').update('output-protected-ledger/inventory/1\0')
    for (const header of db
      .prepare(
        `SELECT kind,key,revision,reserved_bytes AS reservedBytes,
      reserved_updates AS reservedUpdates,bytes,sealed_digest AS sealedDigest
      FROM protected_records ORDER BY kind,key`
      )
      .all()) {
      hash.update(canonicalOutputJSON(header)).update('\n')
    }
    inventory = hash.digest('hex')
  } finally {
    db.close()
  }
  restoreHead(f, head => {
    head.inventory = inventory
  })
}

export function alterStorage(f: Fixture, sql: string): void {
  const db = new DatabaseSync(f.path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}
