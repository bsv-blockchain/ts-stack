# Bounded wallet sync transfers, version 1

This optional transport carries complete BRC-40 request/response objects across
HTTP message limits. It does not change the BRC-40 entity order, inclusive
watermark, ID maps, tombstones, merge rules, or completion condition. Ordinary
pages continue to use `getSyncChunk` and `processSyncChunk`.

## Negotiation and limits

A migrated Knex-backed `StorageServer` advertises `syncTransfer` in runtime
settings: `{ version: 1, maxBytes, partBytes, inlineBytes }`. These are transport
capabilities, not persisted settings columns. `syncTransfers: false` disables
advertisement and transfer RPCs during a mixed-version deployment. A client
must not infer support from compact checkpoints or binary JSON alone.

Version 1 accepts frames up to 64 MiB, with parts no larger than 256 KiB. Parts
are carried by the existing authenticated binary-JSON codec. The frame itself
stores binary fields directly, avoiding a second base64 encoding. The server
uses smaller parts for smaller request or response limits, and leaves this
feature disabled when either limit is below 4096 bytes. This is bounded transfer of
large records, not unlimited-size or constant-memory database streaming: the
current storage and merge APIs still materialize a complete record/page. Records
above the advertised limit fail explicitly; they are never skipped.

## Framing and integrity

A frame starts with a four-byte unsigned big-endian JSON-header byte length,
followed by that many UTF-8 bytes encoded with the existing binary-JSON escaping
rules. The header is `{ version: 1, value, fields }`. Each `fields` entry is
`{ path, length }`: `path` identifies a null placeholder in `value` using object
keys or numeric array indices. Raw field bytes follow the header in entry order.
Dates retain their existing ISO JSON representation. Only actual byte views are
extracted; sync callers first select the declared binary fields with
`syncChunkBinary`. Ordinary numeric arrays retain their semantics.

Decoders reject invalid lengths, missing/duplicate placeholders, unsafe paths,
more than 4096 byte fields, paths deeper than 64 levels, trailing bytes, and
unsupported versions. The manifest SHA-256 covers the entire frame. A receiver
must verify it before decoding and merging. BRC-103 authentication additionally
binds every request/response to the authenticated session.

## RPC sequence

After negotiation a `getSyncChunk` request can include `syncTransferVersion: 1`.
If its normal response exceeds the HTTP ceiling, the server returns
`{ syncTransfer: manifest }` in the JSON-RPC result instead of HTTP 413. The
client reads, verifies and decodes the staged frame before exposing the ordinary
`SyncChunk` to its caller. Requests without the hint keep their legacy response
shape. This avoids repeated oversized responses and repeated source queries.

Every transfer method takes one object in `params`, including the authenticated
`identityKey`. Method arguments below are additional fields in that object.

- `beginReadSyncTransfer`: `{ args: RequestSyncChunkArgs }` returns a manifest.
  The source validates the ordinary sync request and stages an immutable frame.
- `readSyncTransferPart`: `{ transferId, offset }` returns `{ offset, bytes }`.
  Offsets are aligned to `partBytes`; the final part may be shorter.
- `beginWriteSyncTransfer`: `{ digest, totalBytes }` returns a manifest plus
  `receivedBytes`. Identical staged uploads resume after process restarts.
- `writeSyncTransferPart`: `{ transferId, offset, bytes }` returns the next byte
  offset. An identical replay is accepted; changed or out-of-order bytes fail.
- `commitSyncTransfer`: `{ transferId }` verifies a complete frame containing
  `{ args, chunk }`, validates the wallet/storage identities and proofs, then
  invokes the existing atomic page merge with a matching-checkpoint guard.
- `releaseSyncTransfer`: `{ transferId }` removes only staging data.

Manifests contain `{ transferId, digest, totalBytes, partBytes, expiresAt }`.
Identifiers and hashes are 64 lowercase hexadecimal characters. Expiry is Unix
milliseconds. Transfer identifiers never grant access: all lookups also require
the authenticated wallet identity. Unknown/expired and another user's transfers
produce the same unavailable response.

## Recovery and resource ownership

The additive `2026-09-09-001` migration creates `sync_transfers` and
`sync_transfer_parts`. Eight fixed staging slots, at most two per identity,
bound storage to at most 512 MiB of frame data, plus metadata/database overhead.
Allocation and part updates serialize through a database row lock, shared across
replicas. Expired staging is reclaimed on subsequent allocation. The fixed
15-minute expiry bounds retention but may require restarting an expired record.
Staging is storage-global operational data and is excluded from BRC-38 exports.

Uploads retain acknowledged pieces across client/server restart. Interrupted
downloads can retry individual immutable pieces within an attempt; after an app
restart, sync resumes at the last durable BRC-40 record checkpoint and may
re-download the incomplete record. No partial record becomes wallet data.

A lost commit acknowledgement is not automatically replayed by the client.
Retrying sync first rereads the writer checkpoint. A staged commit requires its
watermark and offsets to match the current durable checkpoint under the page
transaction; stale commits cannot advance counters twice. Completed transfer
results are retained until release/expiry, including after a server restart.

Run the wallet migration before enabling the new server code on every replica.
For rollback, stop transfer traffic, preserve the current database, then use the
new runtime's Knex migration source to run **only** this migration down (including
its ledger entry) before restarting the old runtime. This removes incomplete
staging, not wallet records or committed checkpoints; clients can resume those
records. Merely leaving an unknown migration in the ledger can prevent an older
runtime from starting. Never restore an older database over later wallet writes.
The SQLite migration is transactional; table/slot creation is also restart-safe
for MySQL's implicit DDL commits.

## Standards scope

BRC-40 is transport-agnostic. This framing is an optional transport extension;
its reassembled objects retain BRC-40 semantics. Legacy peers still use ordinary
pages and cannot transfer records above their message limits.

BRC-38 specifies canonical portable wallet exports, and BRC-39 specifies their
password-encrypted wrapper. This transport changes neither file format. A live
IndexedDB replica is not itself a BRC-38 or BRC-39 export file. Passing portable
export/import regression tests is evidence for those tested paths, not a blanket
claim that every wallet feature or legacy migration is strictly conformant.

## Artifact cost requiring review

The proposed package budgets include the new framing, validation, integrity and
retry code. Exact packed consumers measured Vite 1,710,390 bytes (403,378 gzip),
esbuild 1,334,082 (366,703 gzip), Metro 1,761,339 (447,423 gzip), and Hermes
3,575,840 (1,435,359 gzip). Browser composition contains only the existing SDK,
wallet client, noble hashes, hash-wasm and IndexedDB dependencies; no Node
storage or new dependency enters the graph. The server staging adapter remains
outside browser/mobile exports.

The raw ceilings increase by 9,000 / 7,500 / 7,500 / 17,500 bytes respectively;
compressed ceilings increase only where the measurement requires it. These
narrow budget changes need explicit maintainer review under the repository
artifact-growth policy. They are feature cost, not a performance improvement.
