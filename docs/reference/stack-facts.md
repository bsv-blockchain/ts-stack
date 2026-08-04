---
id: stack-facts
title: 'Generated Stack Facts'
kind: reference
version: '1.0.0'
last_updated: '2026-07-30'
last_verified: '2026-07-30'
review_cadence_days: 30
status: stable
tags: [reference, packages, versions, runtimes, conformance, generated]
---

# Generated Stack Facts

This page is generated from committed manifests and governance records. Edit the source
manifests, `governance/repository-health/projects.json`,
`governance/documentation-policy.json`, or conformance metadata, then run
`pnpm docs:facts`. CI runs `pnpm docs:facts:check` and rejects drift.

## Support and toolchain

| Profile | Current contract | Authority |
| --- | --- | --- |
| Repository contributors, CI, releases | Node.js >=24.11; pnpm >=10 (pnpm@10.33.2) | root package.json |
| Published npm packages | >=22 for Node consumers; browser/mobile targets remain package-specific | public package manifests |
| Standalone infrastructure | >=24 <25 | service manifests and digest-pinned Dockerfiles |
| TypeScript compiler | npm:typescript@7.0.2 compiler; npm:@typescript/typescript6@6.0.2 tooling API | @bsv/sdk package.json and TypeScript toolchain policy |

Node engine declarations on browser and React Native packages govern package tooling and
Node consumers; they do not require a browser or mobile device to provide Node APIs.

## Public package manifest

The release graph currently contains **31 public packages**. Versions
below are source-manifest versions; registry publication is a separate, explicitly
authorized release action.

| Area | Package | Source version | Project profile | Consumer profiles | Runtime targets | Node engine | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| helpers | `@bsv/air-gap` | `0.1.1` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm | browser, node | `>=22` | [packages/helpers/air-gap](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/air-gap) |
| helpers | `@bsv/amountinator` | `2.1.4` | node-library | node-cjs, node-esm | node | `>=22` | [packages/helpers/amountinator](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/amountinator) |
| helpers | `@bsv/did` | `0.2.4` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm | browser, node | `>=22` | [packages/helpers/did](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/did) |
| helpers | `@bsv/did-client` | `1.2.3` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm, umd-global | browser, node, umd | `>=22` | [packages/helpers/did-client](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/did-client) |
| helpers | `@bsv/fund-wallet` | `1.4.3` | cli | cli | node | `>=22` | [packages/helpers/fund-wallet](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/fund-wallet) |
| helpers | `@bsv/simple` | `0.4.8` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm | browser, node | `>=22` | [packages/helpers/simple](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/simple) |
| helpers | `@bsv/templates` | `1.9.6` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm | browser, node | `>=22` | [packages/helpers/ts-templates](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/ts-templates) |
| helpers | `@bsv/wallet-helper` | `0.1.6` | node-library | node-cjs, node-esm | node | `>=22` | [packages/helpers/bsv-wallet-helper](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/bsv-wallet-helper) |
| helpers | `create-bsv-app` | `1.0.4` | cli | cli | node | `>=22` | [packages/helpers/create-bsv-app](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/create-bsv-app) |
| messaging | `@bsv/authsocket` | `2.1.5` | node-library | node-cjs, node-esm | node | `>=22` | [packages/messaging/authsocket](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/authsocket) |
| messaging | `@bsv/authsocket-client` | `2.1.4` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm, umd-global | browser, node, umd | `>=22` | [packages/messaging/authsocket-client](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/authsocket-client) |
| messaging | `@bsv/message-box-client` | `2.3.0` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm, umd-global | browser, node, umd | `>=22` | [packages/messaging/message-box-client](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/message-box-client) |
| messaging | `@bsv/paymail` | `2.4.6` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm | browser, node | `>=22` | [packages/messaging/ts-paymail](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/ts-paymail) |
| middleware | `@bsv/402-pay` | `0.2.4` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm | browser, node | `>=22` | [packages/middleware/402-pay](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/402-pay) |
| middleware | `@bsv/auth` | `0.1.3` | node-library | node-cjs, node-esm | node | `>=22` | [packages/middleware/auth](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth) |
| middleware | `@bsv/auth-express-middleware` | `2.2.0` | node-library | node-cjs, node-esm | node | `>=22` | [packages/middleware/auth-express-middleware](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth-express-middleware) |
| middleware | `@bsv/payment-express-middleware` | `2.1.5` | node-library | node-cjs, node-esm | node | `>=22` | [packages/middleware/payment-express-middleware](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/payment-express-middleware) |
| network | `@bsv/teranode-listener` | `1.1.4` | node-library | node-esm | node | `>=22` | [packages/network/ts-p2p](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/network/ts-p2p) |
| overlays | `@bsv/gasp` | `1.3.5` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm | browser, node | `>=22` | [packages/overlays/gasp-core](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/gasp-core) |
| overlays | `@bsv/overlay` | `2.3.0` | node-library | node-cjs, node-esm | node | `>=22` | [packages/overlays/overlay](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/overlay) |
| overlays | `@bsv/overlay-discovery-services` | `2.1.6` | node-library | node-cjs, node-esm | node | `>=22` | [packages/overlays/overlay-discovery-services](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/overlay-discovery-services) |
| overlays | `@bsv/overlay-express` | `2.5.0` | node-library | node-cjs, node-esm | node | `>=22` | [packages/overlays/overlay-express](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/overlay-express) |
| overlays | `@bsv/overlay-topics` | `1.6.8` | node-library | node-esm | node | `>=22` | [packages/overlays/topics](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/topics) |
| sdk | `@bsv/sdk` | `2.2.18` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm, umd-global | browser, node, umd | `>=22` | [packages/sdk](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/sdk) |
| sdk | `@bsv/verifast` | `0.3.4` | wasm-library | browser-bundler, browser-esm, node-cjs, node-esm, umd-global, wasm-worker | browser, node, umd, wasm, worker | `>=22` | [packages/verifast](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/verifast) |
| wallet | `@bsv/btms` | `1.1.4` | node-library | node-cjs, node-esm | node | `>=22` | [packages/wallet/btms](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/btms) |
| wallet | `@bsv/btms-permission-module` | `1.1.3` | node-library | node-esm | node | `>=22` | [packages/wallet/btms-permission-module](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/btms-permission-module) |
| wallet | `@bsv/wallet-relay` | `0.3.4` | cli-library | browser-bundler, browser-esm, cli, node-cjs, node-esm | browser, node | `>=22` | [packages/wallet/ts-wallet-relay](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/ts-wallet-relay) |
| wallet | `@bsv/wallet-toolbox` | `2.5.0` | node-library | node-cjs | node | `>=22` | [packages/wallet/wallet-toolbox](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox) |
| wallet | `@bsv/wallet-toolbox-client` | `2.5.0` | browser-library | browser-bundler, browser-esm, node-cjs, node-esm | browser, node | `>=22` | [packages/wallet/wallet-toolbox/client](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/client) |
| wallet | `@bsv/wallet-toolbox-mobile` | `2.5.0` | react-native-library | react-native-metro | react-native | `>=22` | [packages/wallet/wallet-toolbox/mobile](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/mobile) |

## Standalone infrastructure manifests

These versions identify the checked-in service manifests; production identity is
the separately released and verified image digest.

| Service | Package | Manifest version | Node engine | Runtime targets | Release | Source |
| --- | --- | --- | --- | --- | --- | --- |
| BSV Chaintracks Server | `chaintracks-server` | `1.0.17` | `>=24 <25` | node, linux/amd64 | ghcr-keyless | [infra/chaintracks-server](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/chaintracks-server) |
| BSV Message Box Server | `@bsv/messagebox-server` | `1.1.24` | `>=24 <25` | node, linux/amd64 | ghcr-keyless | [infra/message-box-server](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/message-box-server) |
| BSV Overlay Server | `@bsv/overlay-express-examples` | `2.1.27` | `>=24 <25` | node, linux/amd64 | ghcr-keyless | [infra/overlay-server](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/overlay-server) |
| BSV UHRP Basic Server | `@bsv/uhrp-lite` | `0.1.20` | `>=24 <25` | node, linux/amd64 | ghcr-keyless | [infra/uhrp-server-basic](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/uhrp-server-basic) |
| BSV UHRP Cloud Bucket Server | `@bsv/uhrp-storage-server` | `0.2.22` | `>=24 <25` | node, linux/amd64 | ghcr-keyless | [infra/uhrp-server-cloud-bucket](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/uhrp-server-cloud-bucket) |
| Wallet Authentication Backend | `@bsv/wab-server` | `1.4.21` | `>=24 <25` | node, linux/amd64 | ghcr-and-aws-marketplace-keyless | [infra/wab](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/wab) |
| BSV Wallet Infrastructure | `@bsv/wallet-infra` | `2.0.23` | `>=24 <25` | node, linux/amd64 | ghcr-keyless | [infra/wallet-infra](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/wallet-infra) |

## Governed project and release inventory

| Metric | Count |
| --- | --- |
| Governed projects | 38 |
| Package-area projects | 34 |
| Public npm packages | 31 |
| Private package-area projects | 3 |
| Standalone infrastructure projects | 7 |

Public packages use the `npm-oidc` release route. Other workspace projects are
private packages or documentation/conformance tooling. Standalone infrastructure
components are governed separately by `governance/container-images.json` and use their
recorded container release route; they are not published by the public-package job.

## Conformance corpus

| Metric | Current value |
| --- | --- |
| Vector files | 75 |
| Vectors | 6681 |
| Structurally passed | 6470 |
| Governed skips | 211 |
| Required parity vectors | 6477 |
| Intended parity vectors | 204 |
| Explicitly skipped vector entries | 7 |
| Corpus metadata revision | 2026-07-30 |

Structural runner pass/skip results and parity classifications answer different questions:
the former is the current runner outcome, while the latter records cross-language
implementation intent. Neither count may be silently presented as the other.

## Coverage reporting

Coverage numbers below come from the latest committed CI-artifact snapshot, while package
participation comes directly from current manifests. Codecov is the aggregate and
changed-line authority. These are reporting facts, not a claim that the final QA coverage
targets have been completed.

| Metric | Current value | Authority |
| --- | --- | --- |
| Projects with a test:coverage script | 33 | current package manifests |
| Aggregate line coverage | 66.97% | https://app.codecov.io/gh/BSV-blockchain/ts-stack |
| Reported source files | 543 | https://app.codecov.io/gh/BSV-blockchain/ts-stack |
| Reported lines (hit / missed / partial) | 30981 / 11619 / 3659 | https://app.codecov.io/gh/BSV-blockchain/ts-stack |
| Project threshold | 80% for packages/sdk/src | codecov.yml and .github/workflows/ci.yml |
| Changed-line threshold | 90% | codecov.yml and .github/workflows/ci.yml |

The CI workflow generates package-specific LCOV artifacts in parallel, normalizes their
repository paths, combines them in the coverage-upload job, and requires the aggregate
Codecov status before the merge gate succeeds. Updating the committed aggregate snapshot
requires a linked exact-main CI artifact; it must never be estimated from local partial
runs.

## Change procedure

1. Change source manifests or vector files.
2. Update the governed inventory or `conformance/META.json` when its declared facts change.
3. Run `pnpm docs:facts`.
4. Run `pnpm docs:facts:check`, `pnpm health:check`, and the relevant package,
   conformance, documentation, and release checks.
5. Review generated diffs together with the source change. Do not hand-edit this page or
   `conformance/PARITY_MATRIX.json`.

See [Versioning Policy](../about/versioning.md),
[Dependency and Release Policy](./dependency-policy.md), and
[Conformance Testing](../conformance/index.md) for the operational meaning of these facts.
