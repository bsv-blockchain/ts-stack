# Verified private publication records and native lookup binding

This implementation is an internal Node building block for BRC-195. It composes
an original signed capability, exact Bitcoin evidence, protected publication
records and a durable lookup binding. A public HTTP endpoint, installed domain
publisher/schema validation, reconciliation worker and final response disclosure
must still compose these parts. Calling a storage method does not authenticate a
publisher or prove a decryption key matches its content.

## Keep each authority explicit

`SDKPrivatePublicationEvidence` checks the requested Bitcoin output with the real
SDK Script/SPV verifier and an immutable host-selected chain view. It retains the
complete verification context and the exact raw target transaction. It also
requires that the BEEF's default transaction is the requested target; finding the
requested transaction elsewhere in an aggregate cannot redirect Engine submission.
Incomplete ancestry remains unresolved. Cancellation, deadline and changed-view
outcomes are not acceptance. Private bytes never become chain-resolver input.

The installed domain validator must independently authorize the publisher and
bind the asset, public output, schema, private values and key/content relationship.
Its immutable identifier and digest are retained with the verification result.
Neither the caller's claim nor a schema identifier downloads or installs code.
Current authorization and the validity of the verification premises must be
checked again before reservation, admission, binding and disclosure.

`PrivatePublicationContracts` owns the installed seller, chain, endpoint, topic,
service, rules and allowed schema/capacity configuration. New work selects a signed
BRC-101 capability at the current time. Recovery replays its original retained
selection and freshness policy. Manifest expiry prevents new selection but does
not erase an existing obligation. A new discovery result cannot overwrite the
original contract. Retained contract parsing proves those structural and signed
relations; it does not assert present-day authority or Bitcoin unspentness.

## Reserve the complete operation before its effect

The optional third argument to `SQLitePrivatePublicationStore` installs verified
publication semantics. Its original two-argument construction and `stage`, `load`
and `advance` behavior remain available. The verified path is explicit:
`stageVerified` atomically reserves a protected blob, a versioned request fence
with the original contract, and an inactive lookup binding. The binding address
uses a separate HMAC purpose and the exact blob plus installed lookup service and
rules. It is not selected by an incoming record key.

A `private-publication-fence/2` owns the original signed capability, exact target
transaction, complete verification context and immutable validation-policy
reference. A version-1 fence remains readable through the original storage path.
The verified path cannot invent its missing original verification history. A
future migration must preserve the permanent semantic fence and explicitly
reconcile that history; it cannot silently restart the publication.

Preflight reserves the whole future binding and progress envelope, including
admission evidence, the lookup receipt, maximum timestamp and escaped reason
bytes. It separately reserves native record bytes and completion revisions.
Insufficient capacity rejects all initial records together, before admission.
Exact retries preserve the saved contract and material. Two request IDs can share
byte-identical material and a binding while keeping independent fences. Changed
private values for the same exact blob identity conflict.

## Retain admission and commit readiness together

After an admission reservation is durably committed, the private Engine bridge
submits or recovers the same operation. The bridge's original retained receipt
binds the selected topic and output. A duplicate submit's empty STEAK is not that
receipt. Public admission reuse is a separately configured migration policy and
requires independent private validation.

Positive membership moves the publication to binding-pending. `bindVerified`
activates the exact protected lookup binding and commits ready progress in one
native transaction. Its receipt binds the publication ID, semantic request,
shared blob and lookup service/rules, as well as the original admission. An
already active identical binding can support a second request fence, but the
receipt remains specific to that publication. An arbitrary caller-provided
receipt cannot make a version-2 fence ready.

Definitive negative selected-output membership is retained as an internal
`excluded` outcome and projects to BRC-195's existing `rejected` status. It keeps
the original assessment rather than claiming the transaction had no public
effects. Uncertain admission remains pending. A deadline can expire work before
an external-effect reservation; it cannot assert rollback after that reservation.

Independent connections use native global and record revisions. A stale worker
or authorization revoked at the physical commit cannot activate only half the
binding/readiness pair. `loadVerified` reloads the fence, blob and binding in one
current view and checks their relations with the installed contracts. Readiness
loss retains the original evidence; restoration must recover that same material
and binding. A currently readable private key does not itself prove a listing is
unspent or that a paid acquisition is authorized.

## Recovery and disclosure are separate duties

A bounded reconciler discovers stored work, reloads its current revision and
continues the original operation. It must wrap enumeration so that insertions
behind an earlier cursor are eventually visited. A missing blob, key, original
contract or binding cannot become ready through public GASP reconstruction.
Private replication needs its own receiver authorization and protected transport.

Publisher-facing status is only the bounded BRC-195 publication result. The
internal native loader returns protected material to trusted local service code;
it is not a remotely callable status operation. Authenticated routes must return
not-found for inaccessible records and recheck current authority, original
selection and exact response bytes at the physical network enqueue after signing.
A result prepared earlier is not permission to send it later.

Protected lookup availability supports new quotes only when the corresponding
material and binding are available. A funded or reserved acquisition has its own
frozen terms, retained material and recovery obligation. Catalogue withdrawal,
publication eviction and public-output garbage collection do not authorize
removing that material. Paid acquisition and purchase/POTATOES owners will use the
same authoritative seller/chain domain while keeping their state and funding
fences separate.

## Validation boundary

The local native tests cover independent reopen, full original-contract retention,
shared material, conflicting bytes, retained selection on retry, stale-worker
conflicts, commit-time denial, exact readiness restoration and excluded admission.
Actual SIGKILL tests reopen staged, admitting, binding, ready and unavailable
states. Generated restart/revocation schedules exercise all native transition
boundaries. The complete legacy publication suites remain part of qualification.
Real Script/SPV evidence tests use signed synthetic Bitcoin transactions and an
immutable chain fixture. No funded operation or live deployment is involved.

These tests do not by themselves qualify the complete private-overlay service.
The application validator, authenticated HTTP integration, actual Engine/Mongo
and native-store composition, bounded reconciler, paid/purchase owners and final
exact-head CI are separate required program work. The source remains internal
until that composition and its public consumer contract are ready.
