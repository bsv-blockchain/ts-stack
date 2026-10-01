---
id: output-knowledge-workbench
title: 'Running the Output Knowledge Workbench'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: experimental
tags: [utxo, overlay, application, recovery, sqlite, indexeddb]
---

# Running the Output Knowledge Workbench

The workbench makes three different kinds of knowledge visible: verified
transaction history, a host's current catalogue membership, and the client's
progress through a retained source. It uses the actual output runtime,
authenticated Overlay Express lookup companion, SDK verification and persistent
stores. Every transaction and identity is a public fixture on a synthetic
easy-PoW chain. It neither broadcasts transactions nor uses real funds.

## Start two independent hosts

From the repository root, build with
`pnpm --filter output-knowledge-reference-app... build`. In two separate
terminals run:

```sh
REFERENCE_CREATE=1 REFERENCE_HOST=one pnpm --filter output-knowledge-reference-app serve
```

```sh
REFERENCE_CREATE=1 REFERENCE_HOST=two pnpm --filter output-knowledge-reference-app serve
```

Host one serves the workbench at `http://127.0.0.1:4174`; host two uses port 4175. Both bind only to loopback. Their keys are public fixtures and offer no
production access control. Do not expose these listeners through a public proxy.
The original finite lookup routes and ordinary wallet behavior are unaffected.

Each host has its own SQLite index, session store, identity and retained
capabilities. The optional `REFERENCE_DATA` variable selects the parent data
directory. Initial installation is explicit. For later restarts, use the same
role and directory and omit `REFERENCE_CREATE`. A missing database does not
authorize creating an empty replacement under the old service identity.

## Observe, disconnect and recover

Open host one's page in two tabs. Select Alice in one and Bob in the other.
Use the same workspace label, select **Include the other host**, and click
**Start a new view**. The account is part of each local database name, so these
clients retain independent journals and cursors. The fixture wallet authenticates
BRC-103/104 requests; payment is explicitly disabled on these lookup requests.

Publish the catalogue from Alice. Three independent records arrive through live
lookup. A later fresh client receives a bounded snapshot before following live
history. The client requests at most two observations per response, and the
populated-snapshot test proves partial then complete pages. An indivisible
replacement group fits that bound; a consumer must never split such a group to
force it into a smaller limit.

Take Bob offline, then spend and replace the first record from Alice. Withdraw
the independent record from host one's catalogue. Alice learns a verified spend
of the original and a separate membership withdrawal. The latter does not
establish that the independent output was spent.

Reconnect Bob, or close his tab, open a new one, select Bob with the same workspace
and host selection, and click **Resume saved view**. His original control record
and cursor recover the missed changes. Local receipt commitment precedes cursor
advancement. A missing control record fails visibly; the application does not
silently substitute a new opening.

Reintroduce the old first output. Membership returns, but its verified spent
state remains. Open host two's producer page and publish there too. Both clients
can then see two independent memberships for that old output while retaining
the same verified spend. Host two's publication also restores its own membership
for the independent record that host one withdrew. This is legitimate source
divergence, not a Bitcoin consensus disagreement.

“No spend observed” deliberately does not claim universal unspentness. The UI
derives its labels from accepted facts, reconciled source membership and current
assessments. Refreshing or projecting that data never authorizes a wallet action.

## Replace the fixture boundaries deliberately

`referenceProvider.ts` composes the reusable SQLite index/session stores and
registered collection query policy. Its producer verifies known fixture evidence
before writing the read model. Independent publication groups commit separately;
the replacement's withdrawal and new output share one index transaction. This
producer is not an ordinary topic-admission bridge or an on-chain broadcaster.
Production admission must provide its own verified rules, guarded state reads,
durable receipt and atomic projection offset/outbox.

`referenceClient.ts` takes a journal and a control-store factory. The Node
integration supplies SQLite; the UI supplies native IndexedDB. The rest of the
client, including the protocol worker and live source adapter, is shared.
Acquisition, signing and private release remain explicit higher layers. The
workbench does not install private keys into catalogue context or infer a
content license from an output.

Browser storage remains subject to quota, eviction and the user's persistence
decision. Server storage retains bounded session promises and operation fences.
The workbench does not silently prune either side. Exhaustion, an expired
session or incompatible saved state needs an explicit recovery decision.
Preserve the actual databases for a restart demonstration.

## What is exercised

The application tests check signed Script/SPV evidence against the pinned
synthetic header ancestry, partial snapshot pages, two authenticated clients
over actual HTTP, SQLite restart, missed live groups, and the distinction
between a withdrawal and a spend. The production-bundle browser check uses
two provider processes and Chrome/Chromium's native IndexedDB. It closes a tab
without an application shutdown hook, resumes its saved view, and verifies
both source memberships without losing spend knowledge.

The browser harness uses foreground clicks and DOM-mutation waits so background
animation-frame throttling does not masquerade as an application failure. It
does not replace protocol assertions with screenshots.

## Recover an admitted proposal after losing its receipt

The automated `test/proposalPipeline.test.ts` example connects the public
`OutputProposalTransport`, authenticated proposal router, `SDKProposalEvidence`,
`ProposalService`, `SQLiteProposalJournal`, `OverlayProposalAdmission` and ordinary
Engine backed by a three-member Mongo replica set. Run it from the repository root:

```sh
pnpm --filter output-knowledge-reference-app exec vitest run test/proposalPipeline.test.ts
```

Build the workspace dependencies first as above. The existing overlay test
fixture owns randomly named databases, temporary files and loopback ports, and
uses MongoDB 8.2.6. It may download that pinned binary on the first run. It does
not connect to a deployed database. All transaction, author and provider keys
remain public fixtures; no external broadcaster or advertiser is installed.

The author records and reads a signed private proposal. Neither operation admits
ordinary topic state. Another authenticated identity cannot read it, and invalid
Script evidence cannot reserve finalization. A later valid explicit request
creates a reservation and commits a real topic admission. An injected loss after
the Engine commit leaves the proposal journal in `finalizing`, reproducing the
uncertainty a host must recover instead of resubmitting under a new identity.

Both adapters then close and reopen. The recovery scheduler completes the
reservation from the retained Engine receipt even though the original proposal
and manifest have expired, caller authorization is revoked, and discovery and
evidence resolution are unavailable. Assertions require zero new Engine submits
or evidence-verification calls, the original admission identity and the original
assessment context. Restoring caller access permits the serialized original SDK
request to retrieve that same result. Recovery of committed internal work never
bypasses current response authorization.

This test runs real HTTP message authentication through an explicit mapping
from the fixture HTTPS origin to its loopback listener. TLS termination is not
part of its evidence. It also does not restart the Mongo replica processes or
claim recovery from destroyed storage; separate native persistence tests exercise
those failure boundaries. The interactive browser producer and its lookup index
are still separate from this proposal admission pipeline.

Private publication, paid acquisition, covenant authority and wallet composition,
STEAK/POTATOES release, LCH integration, root-host serving fences and native
mobile qualification remain separate implementation work. This demonstration
is evidence for the live lookup and durable client composition, not approval of
the complete BRC-192–199 package or a production deployment.
