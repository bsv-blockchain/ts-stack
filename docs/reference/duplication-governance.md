---
id: duplication-governance
title: 'Duplication Governance'
kind: policy
version: '1.0.0'
last_updated: '2026-07-29'
last_verified: '2026-07-29'
review_cadence_days: 90
status: stable
tags: [reference, quality, sonar, maintainability, compatibility]
---

# Duplication Governance

Duplication is measured debt, not automatically a defect. The stack removes
mechanical copies when one implementation can preserve package independence,
runtime support, and every public API, protocol, storage, error, ordering, and
consensus behavior. It does not create a generic abstraction merely to reduce
a scanner percentage.

`governance/duplication-policy.json` records the reviewed high-value groups,
their disposition, owner, next review, and the proof required before
consolidation. CI rejects missing paths, unowned entries, duplicate IDs, or a
review window longer than 90 days. The prior Overlay Express estimate is
closed: current exact-main analysis reports no authored duplication there.

The current measured baseline is 9,474 duplicated lines at 1.5% density.
This metric is distinct from issue records: eliminating the actionable Sonar
smell backlog does not make cryptographic formulas, portable conformance
vectors, independently deployable service code, or persisted-schema entities
safe to merge.

The principal retained boundaries are:

- SDK curve formulas, whose apparent repetition represents distinct
  consensus-sensitive operations;
- public and private BTMS implementations with material behavioral and package
  differences;
- independently built UHRP services whose Docker contexts cannot import an
  unpublished shared runtime;
- provider and setup peers whose similar flow hides different runtime,
  transport, retry, or lifecycle semantics;
- explicit conformance and arithmetic vectors that must remain portable and
  inspectable; and
- schema/trust-boundary validation that must not be weakened by a shared base.

A future consolidation PR must meet the entry’s `removalProof`, add
characterization at the affected boundaries, and remove or narrow the registry
entry in the same change. Reviewers should reject a reduction in duplicated
lines when it increases branching, cross-package coupling, deployment
coordination, or compatibility risk.
