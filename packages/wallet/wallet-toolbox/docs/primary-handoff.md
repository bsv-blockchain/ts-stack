# Durable primary handoff

The candidate implements local SQL controls, authenticated full/mobile RPC, and
wallet-manager coordination. These unpublished components remain subject to the
complete #544 qualification programme. They do not authorize a release or rollout.

## Application entry point

Continue using the application's existing `WalletStorageManager` and an already
registered backup's storage identity key. The manager negotiates actual controls;
applications do not construct plans or write control tables. Keep each manager's
identity, network and provider registrations specific to one profile.

```ts
await manager.makeAvailable()
await manager.setActive(targetStorageIdentityKey, undefined, { signal })
if (manager.getActiveStore() !== targetStorageIdentityKey || !manager.isActiveEnabled) {
  throw new Error('The requested primary is not available')
}
```

Here `signal` is a caller-owned `AbortSignal`. Progress describes committed copy
work; it does not prove activation or physical cancellation. Warm copying occurs
while sources may remain active, but the short cutover can temporarily make
wallet writes unavailable. No uninterrupted-write guarantee is implied.

Receiver-owned payload parsers preserve the supported SDK2 graph without an
unpublished helper dependency or forced installation. All artifacts and supported
peer combinations must still qualify before release. See [delivery and rollback](delivery-544.md).

## Selection and recovery

`StorageProvider.getPrimaryHandoffControl()` and supported full/mobile clients
return an optional control only when the actual journal backend is supported.
Unenrolled in-memory or rollback-journal SQLite retains its legacy selection path.
An enrolled root whose journal backend becomes unavailable refuses a new control;
its database role and ordinary-writer fences remain enforced. `status`, `prepareSource`, `prepareTarget`,
`retireSource`, `activateTarget`, `completeSource`, `completeTarget`, `followTarget`
and `cancel` own independent short actual database operations. They bind the
current physical provider, network, authenticated user and original role epoch.
The server resolves its own user ID; caller `isActive` and copied IDs grant no
permission. No SQL connection, retained source, manager admission or financial
acknowledgement is serialized as authority.

`WalletStorageManager.setActive` negotiates controls across its actual managed
providers. A canonical operation binds up to eight source identities and original
primary epochs to one target. Source preparation reserves durable intent while
ordinary source writes continue. Target preparation parks a conflicting writable
target, fencing its old prepared operations while preserving its current rows.
The manager reconciles the large data body before arming its inactive-cutover
barrier. It then retires all sources, copies fresh post-retirement deltas, and
requests target activation. Each copy releases source custody and physical
resources before returning. A typed bounded-row resource refusal can negotiate
the existing independent field protocol; schema, permission, proof and transport
failures do not select that continuation. An actual acknowledged or pending field
window selects the same negotiated field protocol on subsequent copies and
replacement managers; it is never reopened through the row receiver. The field
source and destination still acquire and verify their original owners and ACKs. HTTP waits do not retain the manager writer queue.

Activation independently reads real completed destination windows and financial
content receipts for every declared source, with source metadata bound to its
post-retirement epoch and the selected target. Earlier contributors may have
older destination postimages after later contributors merge. At least one actual
final cumulative destination postimage must still match. Pre-retirement copies,
intake-only windows, claimed completion, missing receipts, changed source epochs
or destination drift cannot activate a primary. Selection, epoch/phase update and
selected-primary postimage recording commit atomically; no financial ACK is
manufactured by control.

After activation, explicit source completion permits only target-to-backup DATA;
it never reactivates that source. An already inactive backup can follow the target
through authenticated control. An unaccounted writable participant must instead
retire and copy as a declared source. Actual target-to-backup copies precede
completion of the target intent and removal of the local manager barrier.

Repeated commands for the same intent are idempotent. Competing IDs, targets,
original epochs and participant changes refuse. Lost replies recover from actual
persisted control and destination custody, including through a replacement
manager. A failed or uncertain retired handoff recovers forward; it never silently
reactivates the old source. Cancellation is allowed only before retirement or
activation, and a cancelled parked target remains inactive. A completed or
cancelled local intent can be replaced by a fresh operation ID, preserving role
and epoch checks. Other profiles remain independent.

## Ordinary wallet scheduling

On a supported SQL provider, the manager captures its actual selected provider,
profile and generation briefly, then releases its queue during wallet preparation.
Each financial transaction rejoins that manager admission and uses the original
provider-issued role/epoch capture. Registering or replacing a provider during
preparation rejects the obsolete operation before its next financial commit.
Actual provider instances remain unchanged. Nested writes require their original
explicit transaction token; callbacks retained after the operation finishes cannot
reuse its admission. Other profiles obtain their own independent writer captures. Identical in-flight
action-batch commits share the actual provider operation. A joining caller gets
`alreadyCommitted: true` after its own original writer is rechecked; its reply
does not mutate the first caller’s result or repeat the financial/network work.

Full/mobile clients release manager ownership while awaiting authenticated wallet
RPC, then recheck their original selection. The server still enforces its own
actual SQL writer. Unsupported providers retain the serialized compatibility path.
This scheduling change does not make arbitrary external `runAsWriter` callbacks
concurrent or replace the native owned-provider transition contract.

## DATA and compatibility

Retirement fences both ordinary financial writers and incoming legacy,
snapshot, row-journal and field-journal destination commits. A delayed prepared
page cannot add rows or advance its checkpoint after retirement. The actual
BRC-38 restore/merge writer also defers while its source retirement or target
preparation is pending; read-only previews and journal observations remain
available. It retains the original restore actor, financial kernels and native
ABI rather than deriving permission from handoff metadata. Pending targets
accept only declared source identities. Enrolled DATA user merges preserve actual
primary selection; explicit control owns role changes. Disabling the snapshot
option cannot downgrade an enrolled Knex store into unfenced ordinary writes.

Migration alone enrolls no profiles. Unenrolled older/unsupported providers keep
the explicit serialized compatibility path. Enrolled profiles require
control-aware providers for all future selections; a partially supported enrolled
handoff refuses rather than using the old activation path. Ordinary clients may
continue using the actual selected primary. Upgrade and qualify every local and
remote participant before enrollment; do not run old role-changing binaries over
enrolled databases. Operational intent and copy comparison stamps are not
BRC-38/39 wallet DATA and cannot create SOURCE/native actors or primary grants.

Full/mobile control RPC requires mutual authentication, exact method/argument
shapes, compact binary transport, bounded requests/responses, and the server's
runtime capability. Status is recovery DATA. The authenticated destination still
verifies its own current SQL state and real financial ACKs on activation. Older
servers advertise no control; method presence alone is insufficient. Negotiation
keeps the ordinary JSON/base64 compatibility path. Each control HTTP request,
including negotiation, has its own30s client deadline; configure
`primaryHandoffRequestTimeoutMs` from1..300000ms when needed. That per-request
deadline is independent of the whole-copy duration. `setActive` accepts optional
third-argument sync options, including an `AbortSignal`; negotiated primary
copies and control requests observe it, drain actual custody and preserve durable
recovery state. Observation/cleanup admission remains available after cancellation.
The dedicated snapshot transport may retry a public429 at most twice, after a
bounded250ms..60s hint delay. This unsigned hint only schedules backoff; every
result still requires authenticated transport and the actual destination ACK.
Backoff retains no manager writer or in-flight HTTP request, observes cancellation,
and runs outside each new control request's independent I/O deadline. All server
rate, admission and resource limits remain unchanged.
The ordinary `binaryRequests` flag does not redefine these separately negotiated
compact control RPCs or the mandatory binary codec of version-one transfer parts.
Disable optional server capabilities during a mixed deployment if every serving
instance cannot provide them; preserve the legacy request ceilings.

Unsupported serialized primary providers do not claim this new cancellation
contract. A new request must use a fresh signal to recover uncertain state.

## Forward schema

`2026-10-18-001 add durable primary handoff control` adds
`wallet_primary_handoffs`, bounded `wallet_primary_copy_sources` comparison rows,
and two exact role-control triggers on `users`. Copy stamps are written by actual
destination writers and do not complete financial receipts. The actual control
writer supplies a one-use role transition in its own transaction; the database
consumes it during that same user update. A failed statement rolls back role,
epoch, intent and receipt changes together. Legacy role-changing DATA, old
`setActive` and raw user-role updates cannot bypass an enrolled guard. No-op
replication of the actual selected role remains valid.

SQLite uses the existing source-addition migration: drain live captures, validate
both complete object plans, preserve journal rows/counters/floor, and rotate the
source epoch. MySQL uses a separate fixed recovery row in the existing source
upgrade protocol, marks capture incomplete before nontransactional DDL, permits
only the two individually verified authored trigger additions, preserves all
other source inventory, and restores the generation only after complete
validation. Partial/changed definitions or unrelated drift refuse. Postgres keeps
its existing no-op migration/serialized compatibility contract. Native support
still requires original actual-backend qualification; C, ABI and pins are unchanged.

Schema removal is refused even while empty: MySQL DDL commits implicitly, so an
emptiness check cannot fence concurrent enrollment through trigger removal.
Recover forward and preserve durable intents and guards.

## Qualification

Component feedback is recorded separately from complete acceptance. The full
original financial, native, MySQL, IndexedDB/provider, browser/mobile, large-record,
HTTP failure, recovery, performance, compatibility, mutation and CI/analyzer
programme remains required after feature assembly. Review all failures and the
complete exact-head diff before declaring #544 or PR569 ready. PR569 remains open
and unmerged, with no publication or deployment authorized.
