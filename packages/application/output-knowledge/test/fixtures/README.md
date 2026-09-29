# Approved reconciliation corpus

The JSON fixtures are copied without semantic changes from the approved
[BRC-192–199 packet](https://github.com/bsv-blockchain/BRCs/pull/284), commit
`9dade70dd17d48efb087a2c5da56bb53c164383e`. Transaction bytes, headers, expected
outcomes and the 32 traces remain independent of the reference implementation.

`reconciliation.test.ts` tests the selection function. `worker-traces.test.ts`
binds every operation and every expected field to the default `BitcoinKnowledge`
worker, `KnowledgeStore` and an actual SQLite journal. SDK Script/SPV verification
supplies every positive or invalidity result. The harness controls when verification
is available; it never fabricates a successful verification result from a fixture
label. Restart closes and reopens SQLite and compares the entire reconstructed
snapshot while rejecting any attempt to invoke the verifier.

The journal also contains context, proof and acceptance events. The binding maps
its physical receipt/context positions back to the corpus's logical source-event
positions when comparing orders. It does not supply order to the worker. Raw
receipts contain only the trace's named transactions and its trusted anchors, so
child-before-parent examples really require later evidence from another receipt.
Selected-chain inclusion is introduced through the fixture's actual inclusion
BEEF; view changes use immutable header ancestry. Returning to an earlier chain
view uses a fresh verification-context identity.

Each configured host starts with a completed snapshot and then ordered live
groups. A quarantined source reconciles through a new generation before its next
receipt. Membership pages explicitly marked as snapshot pages retain page order
at their shared watermark. To delay a particular membership proof independently
of existing anchor proofs, the harness adds an unrelated txid-only entry to a
BEEF V2 variant. The verifier still checks the exact target and its full evidence;
the marker only identifies which synthetic worker completion is delayed.

The corpus's `current` set is the unconsumed portion of the locally usable selected
transaction graph. It is not a provider-origin `reported-unspent` claim. Stale UI
choices are recovered from previous accepted reconciliation entries in the journal
and marked against the current pending component; they do not become current
selection. The worker has no action port or signing authority, so these ingestion
traces perform zero wallet actions. They do not qualify wallet purchase workflows.

Run `pnpm --filter @bsv/output-knowledge test -- test/worker-traces.test.ts`.
These journal-backed traces do not replace actual-browser, service transport,
private acquisition, covenant, root-host or application qualification.
