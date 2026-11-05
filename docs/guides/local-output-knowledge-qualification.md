---
id: local-output-knowledge-qualification
title: 'Local Output Knowledge Qualification'
kind: guide
version: '1.0.0'
last_updated: '2026-10-11'
last_verified: '2026-10-11'
review_cadence_days: 30
status: experimental
tags: [utxo, qualification, mutation, compatibility]
---

# Local Output Knowledge Qualification

Local qualification provides early evidence for the exact candidate before its
next push. It preserves the governed target registry, complete original tests,
property corpus, pinned mutation engine, thresholds and supported runtime
profiles. Hosted merge gates remain separate requirements; a local pass must
never be presented as a GitHub Actions run or as complete checkpoint acceptance.
See the [checkpoint inventory](https://github.com/bsv-blockchain/ts-stack/blob/codex/utxo-application-runtime/specs/output-knowledge/CHECKPOINT2.md) for
the complete implementation and acceptance scope.

## Freeze the actual candidate and runtime

Commit the candidate locally before qualification. Run actual application, SDK,
native, property and mutation workloads in an owned Linux environment. Use an
isolated checkout with no credentials or host home mounts. Preserve the source
commit and tree, all tracked bytes, lockfile, exact tools, native libraries,
installed dependencies, generated build outputs and every controller/helper
input. Record a digest of the complete runtime and controller closure. A source,
dependency, build or controller change requires fresh qualification of its
affected evidence; it cannot be silently adopted while readers are active.

Use the root toolchain and the install/build/native preparation documented in
the applicable workflows. Deny dependency lifecycle scripts by default and
rebuild only audited tools. Keep browser, native, mobile, platform, packed
consumer, coverage, conformance and documentation evidence explicit: one runtime
or a pure controller test does not establish another profile's result.

Native synthetic funding must use the installed durable local funding controller
when its purpose is local custody without network publication. Ordinary BRC-100
internalization publishes unmined payments under current upstream wallet behavior.
The reference fixtures retain that production behavior and their broadcast-refusal
guards; they bind each fixture payment to one durable operation, verify its actual
Script/SPV evidence and assert the persisted ownership receipt independently of
publication. Before spending fixture funding, they separately exercise the actual
native publication pipeline with an exact-transaction, owned synthetic response
and verify its persisted status. Recipient fixture setup likewise exercises the
first ordinary fixed-child payout internalization with an exact-transaction
synthetic response. A separate stub restores the original broadcast-refusal
function in `finally` and checks that its call history is untouched. This evidence makes no real-chain funding or publication
claim.

## Bind the complete local mutation campaign

The additive local adapter reuses the existing canonical target, partition,
inventory, raw-execution, global-score and complete-campaign verifiers. It does
not change their hosted identity requirements. Initialize an immutable manifest
outside the checkout, supplying the independently measured runtime closure:

```sh
node scripts/local-mutation-qualification.mjs init \
  --manifest /qualification/campaign.json \
  --runtime-digest "$QUALIFICATION_RUNTIME_DIGEST"
```

The manifest includes a fresh local UUID, explicit `local` origin, exact commit
and tree, Node executable hash/version, Linux architecture, full tracked-source
digest, target registry and complete execution matrix. Hosted run/attempt fields
remain empty. Do not manufacture GitHub IDs or set GitHub environment variables
to make a local receipt pass a hosted verifier.

An independently bounded Linux controller must execute every manifest row with
the original `scripts/mutation-testing.mjs --target TARGET --partition PARTITION`
command. Preserve all 300 property cases, seed 3242026, empty replay path, original
per-case limits, target worker limits and quality thresholds. Schedule workloads
within measured resource capacity; excessive nested parallelism can obscure
correctness and make valid cases time out.

Retain each raw `mutation.json` and `execution.json` unchanged. After physical
drain, record a separate `local-execution.json` containing the manifest's local
identity and exact argv, terminal exit/signal, elapsed/deadline seconds, process
group and verified absence, before/after source and runtime closure digests, raw
report/execution digests, and explicit Boolean timeout, native-fault,
case-timeout, bounded-triage and raw-payload-output observations. A failed sample
is retained as failed evidence even if a later attempt passes. Do not expose raw
counterexamples, native dumps or protected payloads in public logs.

Copy only these three files into each canonical row directory. Whole targets use
`RAW/TARGET`; partitions use `RAW/TARGET/PARTITION`. Evidence must be regular
files, with no symlinks, extra rows or omitted files. Reconcile the full campaign
using the independently remeasured live runtime digest:

```sh
node scripts/local-mutation-qualification.mjs verify \
  --manifest /qualification/campaign.json \
  --directory /qualification/raw \
  --runtime-digest "$QUALIFICATION_RUNTIME_DIGEST" \
  --output /qualification/result.json
```

Verification replays the actual pinned Stryker inventory against current source,
checks every canonical row, reassembles disjoint partitions and enforces each
complete target's global score. Missing, duplicate, stale, diagnostic, mutated,
unguarded or undrained evidence fails. The result is explicitly a local
qualification with `hostedQualified: false`.

## Close the qualification boundary

Inspect terminal results and independently confirm source/runtime custody and
physical worker drain before editing, copying new inputs or releasing ownership.
Apply scoped fixes, preserve failed evidence and repeat the required affected
checks on the final candidate. Push only after the agreed local requirements
pass. After pushing, collect the actual complete hosted gates, analyzer findings
and review resolution on that exact published commit. Neither this guide nor a
successful local verifier declares the branch ready for merge.
