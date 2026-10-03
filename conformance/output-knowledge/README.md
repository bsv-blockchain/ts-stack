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
