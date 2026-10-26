---
id: private-publication-admission
title: 'Private Publication Admission'
kind: guide
version: '1.0.1'
last_updated: '2026-10-05'
last_verified: '2026-10-05'
review_cadence_days: 30
status: experimental
tags: [overlay, custody, recovery, wallet]
---

# Private publication admission

The optional `@bsv/overlay/private-publication-admission` entry supplies
`OverlayPrivatePublicationAdmission` for the ordinary-admission part of a BRC-195
private publication. It uses the existing Engine's `offChainValues` argument and
retained admission history. SDK 3.3.0 or newer is required for this entry. Existing
submission signatures, public receipts and root exports retain their behavior.

This adapter is one part of the publication service. Its result does not establish
private storage, a durable lookup binding, current unspentness, catalogue visibility
or paid delivery. The caller must first verify the exact Bitcoin evidence, publisher
authority and installed schema's asset/key/content relationship, then durably reserve
the protected bytes, immutable request and original contract/context. Ordinary public
GASP reconstruction supplies none of those private guarantees.

## Installation and bounds

Install a fixed Engine, topic manager, seller identity, service name and rules digest.
The underlying storage must expose both the optional atomic admission host and
retained admission-history reader. A declared interface alone is not durability
qualification; the Mongo reference tests exercise actual majority-committed records.
Legacy or unbound applied history remains unresolved.

Supply a synchronous `isCurrent` guard for the original verification context. It must
check current publisher authority, installed schema/service policy and the exact
immutable chain context relevant to this operation. The adapter calls this guard and
rechecks installed Engine/storage/manager/history identities before effects and after
each asynchronous history or submission step. A changed installation yields
`context-changed`. The guard receives owned context bytes; a returned Promise is not
synchronous authorization.

The current Engine accepts at most 100,000 off-chain bytes. The adapter defaults to
65,536 and permits an explicit smaller limit or a limit up to 100,000. The signed
capability's `maxPrivateBytes` must fit the installed limit, and the request must fit
that selected capability. BRC-195's 1 MiB profile ceiling does not enlarge an
implementation's capacity. The requested schema must occur in the original signed
publication profile, and identity, chain, service, rules and capability selection
headers must agree.

Reserve `maximumOutcomeBytes` inside the full stored publication envelope before
calling the adapter. Include the surrounding progress metadata and lookup receipt;
two independently sufficient limits do not establish that their sum fits. A reference
service can choose an explicit 4,096-byte admission allowance and validate the complete
future record against its storage capacity. Before any new Engine submission, the
adapter checks a bound containing every transaction output and both complete input
lists. An oversized outcome fails before effects.

Physical admission work defaults to four concurrent calls, with an explicit bound
from one to 64. There is no waiting queue. A stalled history/Engine call retains its
slot until it settles. Drain calls before closing or replacing caller-owned resources.

## Reserved requests and original receipts

Each job names the authenticated publisher, permanent publication ID, semantic request
digest, reserved operation ID, exact raw transaction and owned BRC-195 request. The
adapter verifies the semantic digest and publication ID, and checks that the BEEF's
default target has those exact raw bytes and contains the requested output. Finding
the same txid elsewhere inside a BEEF does not establish which transaction the Engine
would submit.

Recovery first reads the retained identity for the exact private-values digest. A
committed receipt must bind the installed node/chain scope, transaction, topic,
admission policy and context, and carry the original semantic digest and atomic-local
durability. Selected-topic STEAK indices must be unique, in range and consistent.
Only the selected topic leaves the adapter. The original assessment identity includes
the original admission identity, operation and projected STEAK; newer reservations,
index visibility and propagation observations cannot relabel it.

`admitted` means the original selected-topic receipt includes the requested output.
`excluded` means a valid retained receipt exists but did not admit that output. It does
not assert that the transaction made no other public effects. A complete publication
service must retain that definitive exclusion separately from any claim of rollback.
`unresolved` means the adapter cannot yet establish the outcome. A thrown submit, an
empty duplicate STEAK, missing history or an outstanding commit cannot be converted
into rejection or expiry.

For a new submission, private bytes travel only through the existing off-chain
argument. The public tagged BEEF contains only BEEF and topics. The adapter reads the
same retained history after submission, including after a late error, so a lost reply
can recover the original receipt. An external lookup outbox still being pending does
not imply a private binding is ready.

## Adopting an existing public output

Choose `publicAdmissionReuse: 'disabled'` or the explicit
`'after-independent-private-validation'` policy at installation. With the latter,
recovery may use the original ordinary public-context receipt after the separate
private validation has succeeded. The returned context is `public`; otherwise it is
`matching-private-values`. Matching a digest, particularly an empty-values digest,
must not be presented as independent validation of secret material.

This explicit path matters for existing token formats. The Engine short-circuits a
transaction/topic it already admitted and does not rerun that topic manager with new
private bytes. A duplicate submission therefore cannot attach new private semantics
by implication. Public reuse recovers public admission only. The protected store,
publisher/schema validation and real lookup binding still have to succeed before
the publication service may report ready.

## Reference validation and service composition

Boundary and generated tests cover exact context/selection bindings, owned inputs,
capacity, current guards, duplicate and lost replies, topic projection and output
membership. Native tests use an actual Engine and an isolated three-member Mongo
replica set for private values, restart recovery, explicit public reuse and retained
history after serving eviction. The Mongo bridge fixture pins public BRC-62 proof
roots; independent header-policy validation belongs to the full reference service.
Existing proposal tests run against the shared retained-receipt validator to preserve
their historical assessment bytes and behavior.

The [verified publication service](./verified-private-publication.md) composes
this bridge with native protected storage, schema/publisher verification, lookup
binding, authenticated publication/status routes and final response enqueue.
Its actual Engine/Mongo and HTTP tests exercise retained admission, restart,
private values and authorization changes during signing. The bridge alone
enables neither an endpoint nor a paid availability claim; complete
published-source qualification remains required.
