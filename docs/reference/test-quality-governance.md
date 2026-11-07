---
id: test-quality-governance
title: 'Test Quality and Skip Governance'
kind: reference
version: '1.2.1'
last_updated: '2026-10-05'
last_verified: '2026-10-05'
review_cadence_days: 30
status: stable
tags: [reference, governance, quality, security, testing]
---

# Test Quality and Skip Governance

The required pull-request suite must be deterministic, assertion-bearing, and
honest about what ran. CI rejects:

- a new `test.skip`, `it.skip`, `describe.skip`, `test.todo`, or legacy `xit`
  declaration that is not registered;
- a stale registration after its skip is removed;
- an empty required test body;
- an unclassified `*.man.test.ts` or `*.live.test.ts` file;
- a conformance skip without a reason, owner, review date, exact file count, and
  removal condition; and
- a conformance dispatcher that reaches `not implemented` after the test has
  started. Gaps must be declared in vector metadata instead of passing
  vacuously.

Elapsed `reviewBy` dates are maintenance reminders, never PR failures. This
applies to manual inventories and policies, property suites and exclusions,
mutation policy, required skips, and conformance skip groups across every
package. The CLI prints `MAINTENANCE` warnings and exits successfully when only
dates have elapsed. Unknown owners, malformed dates, missing inventory, and
other structural findings still fail; runtime expiration checks are unchanged.

Run the contract locally:

```sh
pnpm test:governance
```

The machine-readable policy is
`governance/test-quality/policy.json`. It classifies the current suites as:

- **required** — deterministic PR and coverage tests;
- **manual/operator** (`*.man.test.ts`) — one explicitly selected suite that
  may require credentials, a funded identity, a database, cleanup, or human
  inspection;
- **scheduled live** (`*.live.test.ts`) — public-network checks that require no
  private credential but can fail because an external service is unavailable;
- **resource intensive** — deterministic checks that exceed the normal PR
  memory or time budget; and
- **conformance intended gaps** — stable vector IDs with per-file ownership and
  an explicit path to required or permanently unsupported status.

Never batch-run the Wallet Toolbox operator suites. Inspect and execute one
exact path:

```sh
pnpm --filter @bsv/wallet-toolbox test:manual -- \
  src/services/__tests/ARC.man.test.ts
```

Public live examples:

```sh
pnpm --filter @bsv/overlay-express test:live
pnpm --filter @bsv/wallet-toolbox test:live -- \
  src/services/chaintracker/chaintracks/__tests/GoChaintracksServiceClient.live.test.ts
```

The SDK resource boundary is similarly explicit:

```sh
pnpm --filter @bsv/sdk test:resource
```

## Property-based security tests

Required CI uses `fast-check` to generate and shrink unexpected inputs at the
registered packages' highest-risk trust boundaries:

- binary and text codecs: SDK Base58Check, DID base64url/multibase/SD-JWT,
  Bitcoin script numbers, asset outpoints, wallet action packs, and native BDK
  batches, plus wallet script classification and arbitrary OP_RETURN fields;
- public protocol parsers: Paymail addresses, Teranode message envelopes,
  reorg SSE frames, GASP requests/responses and UTXO reconciliation, overlay
  advertisements, Message Box hosts, and wallet pairing URIs;
- authorization and integrity: signed authentication bodies, exact issuer
  allowlists, BASM/TAC hashes, valid relay keys, expiry/freshness windows, and
  reserved-network rejection, plus per-origin BTMS authorization isolation and
  unsigned Bitcoin varint handling;
- HTTP and operator inputs: BRC-121 challenges, authenticated Express byte
  framing, payment replay admission, fund-wallet CLI keys/endpoints/amounts,
  currency conversion/formatting, and project-scaffolder path/configuration
  validation; and
- untrusted application data: Mandala BRC-162 envelope and issuer
  authorization, BTMS metadata and derivation instructions, canonical token
  amounts and asset IDs, and forge-resistant overlay log fields.

These are not round-trip-only tests. Depending on the boundary, the registered
invariants also require an independently encoded oracle, canonicalization,
length and numeric bounds, malformed-input totality, tamper rejection,
authority preservation, exact membership, or deterministic hashing. Generated
collections and byte strings are bounded so every pull request gets useful
coverage without turning CI duration into an unbounded input.

Every property suite and package declaration is registered under
`propertyTesting` in the policy. The governance check rejects a removed suite,
an unregistered `*.property.test.ts`, a missing package command, an undeclared
library/version, a missing trust-boundary/invariant description, or a run budget
below 300 generated cases. It also inventories all package manifests discovered
under `packages/`: each must either own a registered property suite or have a dated, owned exclusion
that explains why the package is only an adapter, composition layer, example,
or platform harness. This prevents both silent coverage gaps and low-value
properties added solely to increase a package count.

Each property is part of its package's ordinary required suite, so pull
requests execute at least 300 cases per property. The independent
`Property fuzzing` workflow runs the same complete registry every Saturday with
5,000 cases per property and a changing explicit seed. It can also be
dispatched manually with a case count, seed, and shrink path. A failing run
preserves its log for 30 days and writes an exact replay command to the workflow
summary.

Run the complete campaign locally (this builds the workspace once first):

```sh
pnpm test:property
```

Run one package while iterating:

```sh
pnpm --filter @bsv/teranode-listener test:property
```

Replay a reported counterexample exactly:

```sh
FAST_CHECK_NUM_RUNS=5000 \
FAST_CHECK_SEED=12345 \
FAST_CHECK_PATH='2:1:0' \
pnpm test:property
```

Fast-check prints the actual seed and shrink path on failure. Do not replace a
shrunk counterexample with a broad skip: first commit it as a deterministic
regression, then fix the implementation, and retain the general property.
Changes that introduce a new parser, codec, serializer, cryptographic framing
rule, network destination, or authorization decision must extend this registry
when an arbitrary-input invariant can be stated.

<a id="mutation-validated-fuzzing"></a>

## Background mutation findings

Mutation testing audits the strength of deterministic and property assertions.
It runs only as background work and never blocks editing, pushes, PR review,
merge, publication or deployment. This applies to every risk tier and shared
control. Scores, old receipts and open mutation findings are not admission inputs.

The complete target/property/source registry remains in
`governance/mutation-testing/policy.json` and `targets.mjs`. No target, canonical
site, property case, deterministic seed, native fixture or per-mutant deadline is
removed to make the audit appear successful. Raw scores, survivors, uncovered and
invalid sites remain visible. Property interruptions and Jest runner deadlines
reported as kills are separately identified as incomplete assertion evidence.

The independent workflow accepts one explicit target/partition from main, has a
30-minute audit job cap and five-minute reporter cap, and retains available raw
reports for 30 days. It has no workflow-call or qualified-source output and no
automatic full-registry schedule. Failed, canceled and incomplete audits raise a
metadata-only triage issue with source/run links; no raw potentially sensitive
failure payload is copied into an issue. Successful audits do not automatically
close existing findings. Security findings follow the private security policy.

Triage survivors into a missing oracle, redundant/equivalent transformation or
actual product defect. Add a focused regression for a reproduced contract failure
and handle it under normal defect/security policy. The actual contract tests
remain relevant to affected changes; the campaign remains nonblocking.

Earlier whole-campaign scheduling and qualification records are preserved in Git
history and `governance/mutation-testing/REVIEW-*.md`. They are historical evidence,
not current release or contribution requirements. Fast unit and installed-compiler
control tests remain ordinary code tests; they do not execute mutation campaigns.

The former reusable admission executor `mutation-execution.yml` is removed,
including its unused checkout and interpolated matrix shell commands. Git history
retains old executions; only the bounded standalone background audit remains.
No publisher or CI caller can invoke the retired executor.
