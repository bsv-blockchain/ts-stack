---
id: about-compatibility
title: 'Compatibility Contract'
kind: meta
version: '1.0.0'
last_updated: '2026-10-23'
last_verified: '2026-10-23'
review_cadence_days: 30
status: stable
tags: [about, compatibility, wallet, brc-100]
---

# Compatibility Contract

Backward compatibility is a project-wide invariant. No change may break an
established compatibility contract or any BRC-100 application-wallet boundary,
even in a new major version. This applies to packages, wallets, services,
transports, dependencies, specifications, generated artifacts, and releases.
Maintainer approval, migration notes, deprecation periods, or first-party
coordination do not waive this invariant.

Applications and wallets are independently deployed across an open ecosystem.
Old WalletClients must continue to work with new wallets, and new clients must
continue to work with old wallets for their established capabilities. Requiring
all deployments to upgrade together is as impractical as coordinating a
breaking upgrade to the HTTP client/server boundary. A repository-wide green
build or a major package version cannot establish that compatibility.

## Preserve the boundary

Preserve public declaration shapes, accepted inputs, result types and meaning,
defaults, errors, method identifiers, binary field order and framing, JSON
representations, validation limits, capability advertisements, origin handling,
and transport behavior. Established persistence and operational contracts are
also covered by the project-wide invariant.

For example, a numeric result cannot become a string or a number/string union
that invalidates existing consumers. An extra binary field cannot be inserted
into an existing response without compatible negotiation. Relaxing a new
client's validator does not make a longer response acceptable to an old client.
Restoring one type declaration alone does not repair an incompatible codec.

New capabilities must be additive. Use explicit opt-in negotiation where a
peer must understand an extension, retain the legacy behavior for peers that do
not advertise it, and give unsupported new operations a compatible error or
fallback. Never infer peer support from the local SDK version. A specification
revision must preserve established valid behavior; updating both first-party
implementations is insufficient.

Security fixes must retain strict validation of malformed or unauthorized
input. Compatibility does not require preserving exploitable behavior. Review
the established valid contract and repair security defects while preserving
that contract; do not use a security change to introduce an unrelated break.

## Evidence required before merge and release

For every affected application-wallet contract:

- identify established consumers, published versions, transports, validation
  limits, and any capability negotiation;
- run integration tests using actual published legacy clients against the new
  wallet side and the new client side against legacy wallet behavior;
- cover JSON and binary transports when affected, retain legacy wire fixtures,
  and test ordinary existing operations as well as optional new capabilities;
- verify result types, arithmetic consumers, errors, pagination, optional
  fields, validation bounds, and absent-capability fallback as applicable;
- preserve focused regression tests, including cases that fail on the proposed
  incompatible behavior; and
- record exact source and package versions, commands, results, and limitations
  in the pull request before merging, then qualify the immutable release
  artifacts through the normal protected workflow.

A finite test matrix does not prove every deployment compatible. Review the
contract itself and expand evidence for any uncovered boundary. If a proposed
change breaks an established contract, redesign it or restore compatibility
before merge and publication. Publish a forward fix for already released
immutable artifacts; never overwrite a published version.
