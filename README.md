# ts-stack

BSV TypeScript monorepo for the SDK, wallet tooling, overlays, messaging, middleware, helpers, infra services, docs, and cross-language conformance vectors.

[![Build and Test](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml/badge.svg?label=build%20%2B%20test)](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml)
[![Conformance](https://github.com/bsv-blockchain/ts-stack/actions/workflows/conformance.yml/badge.svg)](https://github.com/bsv-blockchain/ts-stack/actions/workflows/conformance.yml)
[![codecov](https://codecov.io/gh/bsv-blockchain/ts-stack/branch/main/graph/badge.svg)](https://codecov.io/gh/bsv-blockchain/ts-stack)
[![Security](https://sonarcloud.io/api/project_badges/measure?project=bsv-blockchain_ts-stack&metric=security_rating)](https://sonarcloud.io/component_measures?metric=security_rating&id=bsv-blockchain_ts-stack)
[![Reliability](https://sonarcloud.io/api/project_badges/measure?project=bsv-blockchain_ts-stack&metric=reliability_rating)](https://sonarcloud.io/component_measures?metric=reliability_rating&id=bsv-blockchain_ts-stack)
[![Maintainability](https://sonarcloud.io/api/project_badges/measure?project=bsv-blockchain_ts-stack&metric=sqale_rating)](https://sonarcloud.io/component_measures?metric=sqale_rating&id=bsv-blockchain_ts-stack)
[![npm version](https://img.shields.io/npm/v/@bsv/sdk?label=%40bsv%2Fsdk&color=brightgreen)](https://www.npmjs.com/package/@bsv/sdk)

## What Lives Here

| Area | Path | Purpose |
|---|---|---|
| SDK | `packages/sdk/` | Zero-dependency crypto, Script, transactions, BEEF, Merkle paths, BRC-100 types |
| Wallet | `packages/wallet/` | BRC-100 wallet implementation tooling, relay, token modules, examples |
| Network | `packages/network/` | Teranode P2P topic listener |
| Overlays | `packages/overlays/` | Overlay framework, HTTP server, topics, discovery, GASP, BTMS backend |
| Messaging | `packages/messaging/` | Message Box client, Authsocket, Paymail, Paymail examples |
| Middleware | `packages/middleware/` | Express authentication, payment middleware, HTTP 402 payments |
| Helpers | `packages/helpers/` | Application entry points, templates, DID, wallet utilities, amount conversion |
| Conformance | `conformance/` | Language-neutral JSON vectors and runners for SDK, wallet, overlay, messaging, payments, storage, sync |
| Docs | `docs/`, `docs-site/` | Source docs and the Vite/React documentation site |
| Infra | `infra/` | Deployable servers kept outside the pnpm workspace |

Most applications should start with `@bsv/simple` or `@bsv/sdk`. Wallet builders usually start with `@bsv/wallet-toolbox`. Service operators usually start with the overlay, messaging, middleware, or infra packages.

## Quick Start

Prerequisites:

- Node.js >= 22
- pnpm >= 9; this repo is pinned to `pnpm@10.33.2`

```sh
pnpm install
pnpm build
pnpm test
```

Useful root commands:

| Command | What it does |
|---|---|
| `pnpm build` | Builds every workspace package except the private root package |
| `pnpm test` | Runs every workspace package test script |
| `pnpm lint` | Runs every workspace package lint script |
| `pnpm check-versions` | Verifies cross-package dependency references |
| `pnpm sync-versions` | Updates stale cross-package dependency references |
| `pnpm conformance` | Runs the structural conformance vector runner |
| `pnpm docs:dev` | Starts the documentation site |
| `pnpm docs:build` | Builds and validates the documentation site |
| `pnpm docs:asyncapi` | Regenerates bundled AsyncAPI HTML assets |

To work on one package:

```sh
pnpm --filter @bsv/sdk build
pnpm --filter @bsv/sdk test
pnpm --filter @bsv/sdk run test:coverage
```

## Package Map

### SDK

| Path | Package | Role |
|---|---|---|
| [`packages/sdk`](packages/sdk) | [`@bsv/sdk`](https://www.npmjs.com/package/@bsv/sdk) | Core primitives: keys, signatures, Script, transactions, BEEF, Merkle paths, BRC-100 types |

### Wallet

| Path | Package | Role |
|---|---|---|
| [`packages/wallet/wallet-toolbox`](packages/wallet/wallet-toolbox) | [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) | BRC-100 wallet storage, signer, services, and builder toolkit |
| [`packages/wallet/wallet-toolbox/client`](packages/wallet/wallet-toolbox/client) | [`@bsv/wallet-toolbox-client`](https://www.npmjs.com/package/@bsv/wallet-toolbox-client) | Client-only wallet storage |
| [`packages/wallet/wallet-toolbox/mobile`](packages/wallet/wallet-toolbox/mobile) | [`@bsv/wallet-toolbox-mobile`](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile) | Mobile/client wallet storage |
| [`packages/wallet/wallet-toolbox-examples`](packages/wallet/wallet-toolbox-examples) | [`@bsv/wallet-toolbox-examples`](https://www.npmjs.com/package/@bsv/wallet-toolbox-examples) | Wallet toolbox examples |
| [`packages/wallet/ts-wallet-relay`](packages/wallet/ts-wallet-relay) | [`@bsv/wallet-relay`](https://www.npmjs.com/package/@bsv/wallet-relay) | Mobile-to-desktop wallet pairing relay |
| [`packages/wallet/btms`](packages/wallet/btms) | [`@bsv/btms`](https://www.npmjs.com/package/@bsv/btms) | Basic Token Management System |
| [`packages/wallet/btms-permission-module`](packages/wallet/btms-permission-module) | [`@bsv/btms-permission-module`](https://www.npmjs.com/package/@bsv/btms-permission-module) | Token permission display and checks |

### Network

| Path | Package | Role |
|---|---|---|
| [`packages/network/ts-p2p`](packages/network/ts-p2p) | [`@bsv/teranode-listener`](https://www.npmjs.com/package/@bsv/teranode-listener) | Teranode P2P topic subscription client |

### Overlays

| Path | Package | Role |
|---|---|---|
| [`packages/overlays/overlay`](packages/overlays/overlay) | [`@bsv/overlay`](https://www.npmjs.com/package/@bsv/overlay) | Core overlay services and transaction validation |
| [`packages/overlays/overlay-express`](packages/overlays/overlay-express) | [`@bsv/overlay-express`](https://www.npmjs.com/package/@bsv/overlay-express) | Express HTTP server for overlay services |
| [`packages/overlays/overlay-discovery-services`](packages/overlays/overlay-discovery-services) | [`@bsv/overlay-discovery-services`](https://www.npmjs.com/package/@bsv/overlay-discovery-services) | Overlay service discovery |
| [`packages/overlays/topics`](packages/overlays/topics) | [`@bsv/overlay-topics`](https://www.npmjs.com/package/@bsv/overlay-topics) | Canonical topic managers and lookup services |
| [`packages/overlays/gasp-core`](packages/overlays/gasp-core) | [`@bsv/gasp`](https://www.npmjs.com/package/@bsv/gasp) | Graph Aware Sync Protocol |
| [`packages/overlays/btms-backend`](packages/overlays/btms-backend) | `@bsv/btms-backend` private | BTMS overlay backend |

### Messaging

| Path | Package | Role |
|---|---|---|
| [`packages/messaging/message-box-client`](packages/messaging/message-box-client) | [`@bsv/message-box-client`](https://www.npmjs.com/package/@bsv/message-box-client) | P2P message box client |
| [`packages/messaging/authsocket`](packages/messaging/authsocket) | [`@bsv/authsocket`](https://www.npmjs.com/package/@bsv/authsocket) | Server-side authenticated WebSocket protocol |
| [`packages/messaging/authsocket-client`](packages/messaging/authsocket-client) | [`@bsv/authsocket-client`](https://www.npmjs.com/package/@bsv/authsocket-client) | Authenticated WebSocket client |
| [`packages/messaging/ts-paymail`](packages/messaging/ts-paymail) | [`@bsv/paymail`](https://www.npmjs.com/package/@bsv/paymail) | Paymail protocol library |
| [`packages/messaging/ts-paymail/docs/examples`](packages/messaging/ts-paymail/docs/examples) | `example-paymail` workspace example | Paymail documentation examples |

### Middleware

| Path | Package | Role |
|---|---|---|
| [`packages/middleware/auth-express-middleware`](packages/middleware/auth-express-middleware) | [`@bsv/auth-express-middleware`](https://www.npmjs.com/package/@bsv/auth-express-middleware) | Mutual-authentication middleware for Express |
| [`packages/middleware/payment-express-middleware`](packages/middleware/payment-express-middleware) | [`@bsv/payment-express-middleware`](https://www.npmjs.com/package/@bsv/payment-express-middleware) | Payment-gated Express routes |
| [`packages/middleware/402-pay`](packages/middleware/402-pay) | [`@bsv/402-pay`](https://www.npmjs.com/package/@bsv/402-pay) | BRC-121 HTTP 402 server middleware and client |

### Helpers

| Path | Package | Role |
|---|---|---|
| [`packages/helpers/simple`](packages/helpers/simple) | [`@bsv/simple`](https://www.npmjs.com/package/@bsv/simple) | Recommended high-level browser/server application API |
| [`packages/helpers/bsv-wallet-helper`](packages/helpers/bsv-wallet-helper) | [`@bsv/wallet-helper`](https://www.npmjs.com/package/@bsv/wallet-helper) | Wallet helper functions |
| [`packages/helpers/ts-templates`](packages/helpers/ts-templates) | [`@bsv/templates`](https://www.npmjs.com/package/@bsv/templates) | Script templates |
| [`packages/helpers/did-client`](packages/helpers/did-client) | [`@bsv/did-client`](https://www.npmjs.com/package/@bsv/did-client) | DID resolver client |
| [`packages/helpers/amountinator`](packages/helpers/amountinator) | [`@bsv/amountinator`](https://www.npmjs.com/package/@bsv/amountinator) | Satoshi/BSV conversion and formatting |
| [`packages/helpers/fund-wallet`](packages/helpers/fund-wallet) | [`@bsv/fund-wallet`](https://www.npmjs.com/package/@bsv/fund-wallet) | Testnet/devnet wallet funding helper |

### Infra

These deployable projects are not included in `pnpm-workspace.yaml`; they keep their original server layout under `infra/`.

| Path | Package | Role |
|---|---|---|
| [`infra/message-box-server`](infra/message-box-server) | `@bsv/messagebox-server` private | Message box server |
| [`infra/overlay-server`](infra/overlay-server) | `@bsv/overlay-express-examples` private | Overlay server deployment |
| [`infra/uhrp-server-basic`](infra/uhrp-server-basic) | [`@bsv/uhrp-lite`](https://www.npmjs.com/package/@bsv/uhrp-lite) | Basic UHRP storage host |
| [`infra/uhrp-server-cloud-bucket`](infra/uhrp-server-cloud-bucket) | [`@bsv/uhrp-storage-server`](https://www.npmjs.com/package/@bsv/uhrp-storage-server) | UHRP storage server for cloud bucket deployments |
| [`infra/wallet-infra`](infra/wallet-infra) | `@bsv/wallet-infra` private | UTXO management server |
| [`infra/wab`](infra/wab) | `@bsv/wab-server` private | Wallet Authentication Backend |

## Conformance Vectors

The conformance corpus is the portable contract for other BSV libraries and nodes to test against. Vectors live under [`conformance/vectors`](conformance/vectors), use [`conformance/schema/vector.schema.json`](conformance/schema/vector.schema.json), and are indexed by [`conformance/META.json`](conformance/META.json).

Important entry points:

| Path or command | Purpose |
|---|---|
| `pnpm conformance` | Runs the structural vector runner |
| `pnpm conformance --validate-only` | Validates vector files without executing behavior |
| `pnpm --filter @bsv/conformance-runner-ts test` | Runs the TypeScript/Jest dispatcher for supported vectors |
| [`conformance/VECTOR-FORMAT.md`](conformance/VECTOR-FORMAT.md) | Vector envelope and field rules |
| [`docs/conformance`](docs/conformance) | User-facing conformance docs |

CI publishes the `conformance-vectors` artifact from `main` so downstream SDKs can consume the same vector set.

## Documentation

Documentation source lives in [`docs`](docs). The local site lives in [`docs-site`](docs-site).

```sh
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

Package-level docs start at [`docs/packages/index.md`](docs/packages/index.md). Architecture docs start at [`docs/architecture/index.md`](docs/architecture/index.md).

## Quality Gates

The main CI workflow builds, lints, tests, generates SDK coverage, uploads Codecov coverage, and runs SonarCloud. The workflow expects the organization secrets already used by the BSV repositories:

- `CODECOV_TOKEN`
- `SONAR_TOKEN`

Coverage upload is currently based on the SDK LCOV report and normalized to repo-root paths by [`scripts/normalize-lcov-paths.mjs`](scripts/normalize-lcov-paths.mjs). Root configuration lives in [`codecov.yml`](codecov.yml) and [`sonar-project.properties`](sonar-project.properties).

## Releases

Releases use GitHub Actions with npm OIDC provenance; no static npm token is required. Push a tag matching `<package-path>/v*` for a package release, or `v*` for a rare monorepo-wide release. Package tags publish the package at the tagged path; monorepo-wide tags publish packages changed since `origin/main`.

Each published package must be configured as an npm trusted publisher:

- Owner: `bsv-blockchain`
- Repository: `ts-stack`
- Workflow: `release.yaml`
- Environment: leave blank

## Updating Imported Packages

Many packages were imported with `git subtree` and retain their upstream history. When pulling upstream changes, use the actual prefix from the package map:

```sh
git subtree pull --prefix=packages/sdk <remote> <branch>
```

Keep unrelated package history and generated artifacts out of the same change when possible.

## License

See the individual package directories for license terms.
