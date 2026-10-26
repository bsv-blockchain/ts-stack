---
id: private-publication-lookup-context
title: 'Recipient-authorized private lookup context'
kind: guide
version: '1.0.0'
last_updated: '2026-10-03'
last_verified: '2026-10-03'
review_cadence_days: 30
status: experimental
tags: [overlay, private, lookup, custody, authorization]
---

# Recipient-authorized private lookup context

A private overlay holds information that is absent from the public transaction.
The original Engine interfaces already accept off-chain submission values, pass
those values through topic and lookup admission hooks, and let a lookup formula
attach context to an output's BEEF. Authentication, payment and the application's
meaning of that context belong to separate layers. Merely returning context does
not establish a purchase, a licence or a correct decryption key.

`PrivatePublicationLookupContext` is an optional Node companion for protected
BRC-195 publication custody. It lets a separately authorized reader obtain legacy
BRC-101 lookup context from an originally admitted publication. Publisher-facing
status recovery remains a different interface: being authorized to publish is
insufficient to read another participant's context. This companion advertises no
paid-acquisition or covenant-purchase profile. Install those existing companions
when an endpoint promises BRC-196 or BRC-198 fulfillment.

## Select authority before private material

Build the caller from the transport's authenticated identity and cancellation
state. Neither a query field nor an incoming record key establishes that identity.
The reader verifies the publication fence, original publisher/request relation,
selected chain/topic and active lookup binding. A missing publication, wrong
recipient or unavailable grant produces the same `not-found` outcome before
mapping its private material. Error and control bodies must omit identifiers,
context and candidate headers.

The installed `authorize` callback receives a `ProtectedLedgerView`. Read durable
entitlement records through that view, inside the same native guard as the
publication's metadata. Calling `ledger.read` from the callback would try to enter
the writer gate again and is refused. Writers of those rules must use the same
native domain. An external permission service requires its own explicitly
coherent installed fence; an asynchronous boolean check alone cannot establish
current authority at physical send time.

`mapContext` receives owned private bytes, an owned public reference and the
trusted recipient. It is synchronous, bounded and free of I/O or financial work.
It can select a recipient-specific envelope or capability rather than returning
the stored blob wholesale. The host's publication validator must already have
established the private material's relation to the public asset. Mapping and
retrieving those bytes do not prove that relation again.

## Hydrate with a request-local service

Prepare one reader result, then give its owned formula to a request-local lookup
service and Engine. That Engine may share the ordinary native transaction storage
and tracker. Never put the recipient's formula into the shared public lookup
registry. Public catalogues should continue returning public outpoints and BEEF.

```ts
// Also compiled against exact tarballs in the compiled-package-examples guide.
import {
  PrivatePublicationLookupContext,
  type PrivatePublicationLookupCaller,
  type PrivatePublicationLookupContextOptions
} from '@bsv/output-knowledge/private/node'

function preparePrivateContext(
  installation: PrivatePublicationLookupContextOptions,
  publicationId: string,
  authenticatedCaller: PrivatePublicationLookupCaller
) {
  const reader = new PrivatePublicationLookupContext(installation)
  const prepared = reader.prepare(publicationId, authenticatedCaller)
  return {
    formula: prepared.formula(),
    bindHydratedAnswer: (answer: unknown) => prepared.bind(answer),
    dispose: () => prepared.dispose()
  }
}
void preparePrivateContext
```

The bound answer must contain exactly the selected output, its original raw
transaction and the mapped context. A contradictory Atomic BEEF marker, a
missing raw subject, changed output or altered context is refused. Plain BEEF
may contain additional raw history while selecting that exact subject explicitly.
This binding checks serialization and original custody; any new proof or present
unspentness assertion still requires its own evidence/currentness verifier.

## Hold the native fence through physical enqueue

Hydration and BRC-104 response signing run outside the protected writer gate.
Install the middleware's authenticated response guard before writing the response.
Its final callback passes the actual synchronous physical enqueue to the bound
result. The reader rechecks the installed owner methods, authenticated caller,
recipient policy, exact protected revision, original fence/blob/binding and owned
response bytes. A separate connection revoking a grant or changing readiness
before enqueue prevents disclosure. A stale signed body must become a newly
signed, identifier-free control response; filtering its outputs would change
what was authenticated.

Use private, no-store headers. Dispose the prepared reader in every success,
refusal and disconnect path. Owned byte buffers are cleared on disposal; this
is not a claim that JavaScript strings, transport buffers or the process heap can
be securely erased. One binding permits one physical attempt. An uncertain send
cannot be retried by calling that same binding again.

On restart, reopen the original native domain and publication store with their
persisted identity/configuration and construct a new reader. Do not manufacture
another store or grant when one is missing. This interface does not issue a key,
retry admission, create wallet actions or charge for a lookup.

## Keep synchronization public

Classic Engine CRUD admission directly calls lookup hooks with off-chain values.
Atomic Mongo admission instead retains external lookup work in its durable
outbox. A host choosing that profile must install and recover the appropriate
idempotent outbox consumers; it must not claim that a committed intent already
ran a callback. The context reader uses protected READY custody independently of
that public notification path.

The native host demonstration is
`PrivatePublicationLookup.integration.test.ts` in Overlay Express. It exercises
real Engine/Mongo admission and the original classic hook plumbing separately,
authenticated recipient lookup, a separate native entitlement writer revoking
after signing, protected restart and unchanged original admission. Its public
finite lookup, native progressive snapshot/live replay and GASP history contain
public evidence without private context. The outbox check proves a durable intent;
it does not qualify a generic outbox dispatcher.
