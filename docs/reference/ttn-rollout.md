---
id: ttn-rollout
title: 'TerraTestNet Rollout Gate'
kind: reference
version: '1.0.0'
last_updated: '2026-08-10'
last_verified: '2026-08-10'
review_cadence_days: 30
status: draft
tags: [reference, ttn, releases, containers, operations]
---

# TerraTestNet Rollout Gate

The merged TTN source is a release-held candidate. It does not make the
currently published packages or infrastructure images TTN-capable, and merging
it does not authorize a package release, image build, or deployment.

## Required release order

1. Publish the reviewed TTN package candidates through the OIDC release
   workflow, beginning with `@bsv/sdk` and then its affected dependents.
2. Reconcile every infrastructure package manifest and lockfile to the newly
   published versions. In particular, the checked-in overlay, wallet, Message
   Box, WAB, ChainTracks, and UHRP image manifests still resolve pre-TTN SDK or
   wallet/overlay package versions.
3. Rebuild Linux/amd64 images in CI, retain their immutable digests and
   attestations, and run the container smoke and vulnerability gates.
4. Provision a dedicated TTN Message Box endpoint. TTN clients intentionally
   require an explicit `host` until this exists; the existing staging Message
   Box is testnet and must not be reused as a TTN default.
5. Provision and validate a TTN overlay discovery root before advertising
   production-like services. Do not use a testnet overlay host as a TTN root.
6. Deploy the staging environment with `ttn`/`teratestnet` selected explicitly,
   then validate health responses, reported chain identity, transaction
   broadcast, proof acquisition, SHIP/SLAP isolation, Message Box delivery, and
   wallet storage before promoting any workload.

## Runtime invariants

- TTN broadcasting uses Arcade's EF `/tx` contract. The incompatible legacy
  ARC BEEF `/v1/tx` provider is not registered as a TTN fallback.
- BRC-100 wallets still report `testnet` for test-family chains, so every
  overlay-facing TTN component must receive `teratestnet` explicitly.
- Mainnet, testnet, and TTN deployments use separate configuration, storage,
  discovery roots, credentials, DNS, certificates, databases, and image
  promotion records.
- Rollback restores the previous immutable image digests and configuration; it
  never redirects TTN traffic into testnet or mainnet infrastructure.

Until all gates above have exact-main evidence, keep TTN workloads undeployed.
