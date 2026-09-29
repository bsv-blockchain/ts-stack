# Output knowledge implementation qualification

This branch implements the proposed [BRC-192–199 packet](https://github.com/bsv-blockchain/BRCs/pull/284).
The specification checkpoint is approved for implementation. The implementation
checkpoint remains open; neither an initial package version nor passing foundation
tests announces completion, publication or production qualification.

The core contracts remain application-neutral. Application examples demonstrate
the contracts without defining their semantics. Existing wallet, overlay, lookup,
submission and GASP behavior remains available to applications that do not opt in.

## Implemented foundation

- Additive SDK wire codecs, canonical encodings, digest domains, signed capability
  profiles, observation schemas and bounded BRC-193 request/response schemas.
- Memory, SQLite and IndexedDB receipt journals with atomic local replay material,
  exact U64 revisions, compare-and-swap and recovery after an uncertain append.
- Exact-target BEEF assembly, alternative cross-source evidence, actual SDK
  Script/SPV verification, historical readiness and deterministic spend selection.
- Whole-group acceptance, source membership order, generation replacement, context
  fences and projection publication independent of authorized wallet actions.
- The default Bitcoin reducer/worker, including recovery of accepted decisions
  without network access and explicit sealing of the journal's non-final policy.
- Bounded wallet basket pages, finite provider-scoped lookup receipts and direct
  delivery with commit-before-acknowledgement. Optional adapters live under the
  separate `@bsv/output-knowledge/sources` entry.

## Remaining checkpoint-two work

- Qualify the full approved reconciliation trace corpus through real journals and
  the default worker, including all source, historical-context and restart cases.
- Add explicit scoped source-currentness policy, durable freshness invalidation,
  proposal namespaces, validation policies and finalization/admission bridges.
- Implement authenticated BRC-193 snapshot/replay/long-poll transports, cancellation,
  retention, source adapters and consistent Overlay/Overlay Express storage hooks.
- Bind BRC-101 capability selection to the authenticated transport and explicit
  non-final profiles while preserving finite legacy defaults.
- Exercise existing private off-chain values and lookup context, then implement
  acquisition, funding/recovery, STEAK/POTATOES readiness and secret release.
- Implement and qualify the exact BRC-197 Script template, lineage validation,
  purchase, split, merge, payout, unanimous recipient-change and retirement routes.
- Integrate BRC-198 LCH acquisition and playback without changing BRC-170 behavior.
- Implement BRC-199 root-host output eviction, all serving/replay/admission/GASP
  fences, restoration and multi-host consistency demonstrations.
- Complete a working reference application, actual-browser persistence/restart,
  multi-host demonstrations and an application consuming live lookup updates.
- Finish API guides, operator guidance, conformance, property/mutation evidence,
  mobile/browser/packed-consumer checks and all exact-head remote quality gates.

Downstream application migrations follow the second review checkpoint. No package
publication, deployment or merge is authorized by this implementation checklist.

## Validation evidence and limits

The foundation SDK run passes 7,608 tests across 215 suites. The output-knowledge
run passes 147 tests across 14 suites, with more than 91% line and 85% branch
coverage. Journal append mutation testing kills all 26 generated mutations.
The source tests include a held SQLite append, storage failure, finite pagination,
non-cancellable wallet I/O, independent fast/slow hosts and host-local refresh. Observation identities remain immutable within their complete
source epoch across local refresh generations and SQLite restart.

Root health, lint, formatting and type checking pass. Packed-consumer resolution
and both declared browser entries pass. Core browser byte limits remain unchanged;
the optional adapter entry is independently measured and enforced. IndexedDB unit
tests use fake-indexeddb, so actual-browser qualification is still required. The
existing selection-function trace tests are not a substitute for complete journal
and worker trace qualification.

These are local, intermediate results. The PR remains draft until the entire
checkpoint and all required checks succeed on its exact final head. Remote CI,
CodeQL and Sonar evidence must be recorded in the PR before review.
