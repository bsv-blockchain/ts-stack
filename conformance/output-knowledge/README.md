# Output protocol conformance fixtures

The frozen [BRC-199 wire vectors](../../packages/sdk/src/overlay-tools/__tests/fixtures/root-eviction-wire.json)
contain complete signed requests/results and expected request, advertisement,
decision and result digests. Their UTF-8 JSON SHA-256 is
`fcde42cc6fbeb2ef872206409c57d0410df17641a19453003828e15a7eb1ec4a`.
The SDK protocol suite executes the vectors from this single source; they are
not yet a new domain in the central conformance runner.

Use BRC-192 canonical JSON and the `BRC-OUTPUT/1/<domain>\0` digest prefix,
including the final NUL byte, then SHA-256. Verify each anyone-verifiable BRC-77
signature against the separately bound requester or root identity. The expected
digests were also reproduced with Python's independent SHA-256 implementation.
The fixture contains public synthetic identities and no deployment credentials.

The five cases cover two independent suppression bases, lifting only the first,
the same immutable restoration with a later serving assessment, and a pending
action. An unresolved assessment after the last blocker disappears deliberately
does not claim currentness or eligibility. Historical signed results are
observations at their issue times, not universal or current root policy.

These are wire-only examples. The mock chain, opaque non-transaction BEEF and
OP_TRUE script are not valid SHIP/SLAP advertisement evidence. Passing them does
not qualify evidence verification, requester authority, durable effects or any
serving adapter. Those require the separate BRC-199 service integration tests.

## Current shared proposal and reconciliation corpus

The fixtures under `packages/application/output-knowledge/test/fixtures/brc295/`
come from BRC PR295 at immutable commit
`1b9a75e497b5856675af1ce01fd86843c37d07f9`. Repository formatting changes only
JSON whitespace. Signed envelopes, exact transaction bytes, expected digests,
all model cases and their order match that upstream corpus. The upstream raw
reconciliation-vector SHA256 is
`040488ef77afd25ff4ee2a29be365a568bd6e8401c654e6a97f70a57c014ea6f`;
the raw trace SHA256 is
`4dacec377c6b90d280f63f0d7d04dc55b90c7abab85113bf2129292a0b879c04`.

`test/proposal-channel-conformance.test.ts` checks the three original signed
heads, four frozen selection digests, all sixteen query-mapping cases, ten
invalid queries and the exact 256-channel boundary. Host-readable flags are
controlled fixture inputs. Changed captured visibility is tested through the
actual SQLite session disclosure guard; anonymous empty-snapshot refusal uses
the authenticated opening codec. These tests bind the shared model to query and
guard components. They do not qualify a provider's access-policy writer,
authenticated HTTP or physical enqueue. The existing proposal-native and host
integration selectors qualify those separate boundaries.

All original 32 reconciliation traces and their original transactions remain
unchanged and continue running through the existing reconciler and default-worker
tests. The current shared corpus adds two expiry-retirement traces and three
transactions. `test/reconciliation-current-conformance.test.ts` executes every
actual retirement input against its exact source output, checks the complete
shared finality matrix, and binds both new traces to `reconcileOutputSpends` and
real SQLite journal reopen. Pre-maturity intent does not consume the listing,
whether non-final selection is enabled or disabled. Strict height finality
allows the first candidate block at `expiryHeight + 1`.

The new corpus explicitly declares two fixture-trusted roots and synthetic
height contexts. They are model premises, not SPV proofs, verified genesis
history or live chain authority. Actual current-family lineage, protected wallet
routes and native acquisition/HTTP require their independent reference
integration tests. Passing this corpus alone does not qualify those integrations
or the final mutation and Checkpoint 2 gates.
