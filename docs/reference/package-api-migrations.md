---
id: package-api-migrations
title: 'Package API, Declarations, and Migration Ledger'
kind: reference
version: '1.0.0'
last_updated: '2026-07-28'
last_verified: '2026-07-28'
review_cadence_days: 30
status: stable
tags: [reference, packages, api, declarations, migrations, release-notes]
---

# Package API, Declarations, and Migration Ledger

This page is generated from all 30 public manifests, package documentation, and
`governance/package-release-notes.json`. It records source candidates without
publishing them. CI rejects a version change unless its release classification,
summary, and migration guidance are updated at the same time.

The declaration targets below describe the packed manifest contract. The
package pages remain the human API and usage authority; generated declarations
and clean-consumer tests remain the executable type authority.

## Current release boundary

| Package                           | npm baseline | Source   | Candidate | API                                                                   | Migration                                                                                                                                                                                                                        |
| --------------------------------- | ------------ | -------- | --------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@bsv/402-pay`                    | `0.2.1`      | `0.2.1`  | none      | [API and usage](../packages/middleware/402-pay.md)                    | No migration is pending for the current source version.                                                                                                                                                                          |
| `@bsv/amountinator`               | `2.1.1`      | `2.1.2`  | patch     | [API and usage](../packages/helpers/amountinator.md)                  | No consumer migration is required; this is a backward-compatible patch candidate.                                                                                                                                                |
| `@bsv/auth`                       | `0.1.1`      | `0.1.1`  | none      | [API and usage](../packages/middleware/auth.md)                       | No migration is pending for the current source version.                                                                                                                                                                          |
| `@bsv/auth-express-middleware`    | `2.1.2`      | `2.1.3`  | patch     | [API and usage](../packages/middleware/auth-express-middleware.md)    | No consumer migration is required; existing public CORS defaults and middleware APIs are retained.                                                                                                                               |
| `@bsv/authsocket`                 | `2.1.1`      | `2.1.2`  | patch     | [API and usage](../packages/messaging/authsocket.md)                  | No existing behavior changes automatically; service owners can call await server.close() during graceful shutdown.                                                                                                               |
| `@bsv/authsocket-client`          | `2.1.1`      | `2.1.1`  | none      | [API and usage](../packages/messaging/authsocket-client.md)           | No migration is pending for the current source version.                                                                                                                                                                          |
| `@bsv/btms`                       | `1.1.1`      | `1.1.2`  | patch     | [API and usage](../packages/wallet/btms.md)                           | No consumer migration is required; token and lookup wire contracts are unchanged.                                                                                                                                                |
| `@bsv/btms-permission-module`     | `1.1.1`      | `1.1.1`  | none      | [API and usage](../packages/wallet/btms-permission-module.md)         | No migration is pending for the current source version.                                                                                                                                                                          |
| `@bsv/did`                        | `0.2.1`      | `0.2.1`  | none      | [API and usage](../packages/helpers/did.md)                           | No migration is pending for the current source version.                                                                                                                                                                          |
| `@bsv/did-client`                 | `1.2.1`      | `1.2.1`  | none      | [API and usage](../packages/helpers/did-client.md)                    | No migration is pending for the current source version.                                                                                                                                                                          |
| `@bsv/fund-wallet`                | `1.4.1`      | `1.4.1`  | none      | [API and usage](../packages/helpers/fund-wallet.md)                   | No migration is pending for the current source version.                                                                                                                                                                          |
| `@bsv/gasp`                       | `1.3.1`      | `1.3.2`  | patch     | [API and usage](../packages/overlays/gasp.md)                         | No consumer migration is required; existing constructor calls and synchronization behavior are unchanged.                                                                                                                        |
| `@bsv/message-box-client`         | `2.2.2`      | `2.2.4`  | patch     | [API and usage](../packages/messaging/message-box-client.md)          | No consumer migration is required; Message Box protocol and client entry points are unchanged.                                                                                                                                   |
| `@bsv/overlay`                    | `2.2.1`      | `2.2.3`  | patch     | [API and usage](../packages/overlays/overlay.md)                      | No consumer migration is required; existing imports remain valid and the documented storage subpath is restored.                                                                                                                 |
| `@bsv/overlay-discovery-services` | `2.1.1`      | `2.1.4`  | patch     | [API and usage](../packages/overlays/overlay-discovery-services.md)   | No consumer migration is required; discovery records and public network behavior are unchanged.                                                                                                                                  |
| `@bsv/overlay-express`            | `2.4.2`      | `2.4.7`  | patch     | [API and usage](../packages/overlays/overlay-express.md)              | No consumer migration is required; wildcard credential-free public access remains the default and runtimes may opt into the new close method.                                                                                    |
| `@bsv/overlay-topics`             | `1.6.1`      | `1.6.6`  | patch     | [API and usage](../packages/overlays/overlay-topics.md)               | No consumer migration is required; topic IDs, lookup contracts, and persisted formats are unchanged.                                                                                                                             |
| `@bsv/paymail`                    | `2.4.2`      | `2.4.3`  | patch     | [API and usage](../packages/messaging/paymail.md)                     | No consumer migration is required; existing Paymail client APIs and protocol semantics are retained.                                                                                                                             |
| `@bsv/payment-express-middleware` | `2.1.1`      | `2.1.2`  | patch     | [API and usage](../packages/middleware/payment-express-middleware.md) | No consumer migration is required; legacy x-bsv-payment JSON behavior remains supported.                                                                                                                                         |
| `@bsv/sdk`                        | `2.2.0`      | `2.2.9`  | patch     | [API and usage](../packages/sdk/bsv-sdk.md)                           | No consumer migration is required; the source candidate preserves the 2.x public API and supported import forms.                                                                                                                 |
| `@bsv/simple`                     | `0.4.1`      | `0.4.5`  | patch     | [API and usage](../packages/helpers/simple.md)                        | No consumer migration is required; the browser and server entry points remain compatible.                                                                                                                                        |
| `@bsv/templates`                  | `1.9.1`      | `1.9.2`  | patch     | [API and usage](../packages/helpers/templates.md)                     | No consumer migration is required; template APIs and generated script semantics are unchanged.                                                                                                                                   |
| `@bsv/teranode-listener`          | `1.1.1`      | `1.1.2`  | patch     | [API and usage](../packages/network/teranode-listener.md)             | No consumer migration is required; listener APIs, topics, and network configuration are unchanged.                                                                                                                               |
| `@bsv/verifast`                   | `0.3.0`      | `0.3.1`  | patch     | [API and usage](../packages/sdk/verifast.md)                          | No consumer migration is required; valid verification results and worker protocols are unchanged.                                                                                                                                |
| `@bsv/wallet-helper`              | `0.1.1`      | `0.1.3`  | patch     | [API and usage](../packages/helpers/wallet-helper.md)                 | No consumer migration is required; fluent builder APIs and transaction semantics are unchanged.                                                                                                                                  |
| `@bsv/wallet-relay`               | `0.2.2`      | `0.3.0`  | minor     | [API and usage](../packages/wallet/wallet-relay.md)                   | QRPairingCode now renders a native button and accepts button wrapper attributes. Existing className, style, data, and ARIA props continue to work; update div-specific wrapper selectors or explicitly typed div event handlers. |
| `@bsv/wallet-toolbox`             | `2.4.4`      | `2.4.12` | patch     | [API and usage](../packages/wallet/wallet-toolbox.md)                 | No consumer migration is required; persisted schemas and the 2.x wallet and storage interfaces remain compatible.                                                                                                                |
| `@bsv/wallet-toolbox-client`      | `2.4.4`      | `2.4.12` | patch     | [API and usage](../packages/wallet/wallet-toolbox-client.md)          | No consumer migration is required; client entry points and remote storage contracts remain compatible.                                                                                                                           |
| `@bsv/wallet-toolbox-mobile`      | `2.4.4`      | `2.4.12` | patch     | [API and usage](../packages/wallet/wallet-toolbox-mobile.md)          | No consumer migration is required; React Native and mobile bridge contracts remain compatible.                                                                                                                                   |
| `create-bsv-app`                  | `1.0.2`      | `1.0.2`  | none      | [API and usage](../packages/helpers/create-bsv-app.md)                | No migration is pending for the current source version.                                                                                                                                                                          |

`none` means the source manifest matches the recorded npm baseline. Any other
value is an unpublished candidate. Publication, tags, releases, registry
reconciliation, and infrastructure dependency synchronization remain separate,
explicitly authorized operations.

## Package entry points

## @bsv/402-pay

- Package documentation: [docs/packages/middleware/402-pay.md](../packages/middleware/402-pay.md)
- Source: [packages/middleware/402-pay](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/402-pay)
- Release note: The source manifest matches the published package; no unpublished release candidate exists.
- Migration: No migration is pending for the current source version.

| Public subpath | Runtime target(s)                          | Declaration target(s)                          |
| -------------- | ------------------------------------------ | ---------------------------------------------- |
| `.`            | `./dist/index.mjs`<br>`./dist/index.cjs`   | `./dist/index.d.mts`<br>`./dist/index.d.cts`   |
| `./server`     | `./dist/server.mjs`<br>`./dist/server.cjs` | `./dist/server.d.mts`<br>`./dist/server.d.cts` |
| `./client`     | `./dist/client.mjs`<br>`./dist/client.cjs` | `./dist/client.d.mts`<br>`./dist/client.d.cts` |

## @bsv/amountinator

- Package documentation: [docs/packages/helpers/amountinator.md](../packages/helpers/amountinator.md)
- Source: [packages/helpers/amountinator](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/amountinator)
- Release note: Adds the strict package and artifact contract and hardens amount formatting without changing the public API.
- Migration: No consumer migration is required; this is a backward-compatible patch candidate.

| Public subpath | Runtime target(s)                        | Declaration target(s)                        |
| -------------- | ---------------------------------------- | -------------------------------------------- |
| `.`            | `./dist/index.mjs`<br>`./dist/index.cjs` | `./dist/index.d.mts`<br>`./dist/index.d.cts` |

## @bsv/auth

- Package documentation: [docs/packages/middleware/auth.md](../packages/middleware/auth.md)
- Source: [packages/middleware/auth](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth)
- Release note: The source manifest matches the published package; no unpublished release candidate exists.
- Migration: No migration is pending for the current source version.

| Public subpath | Runtime target(s)                        | Declaration target(s)                        |
| -------------- | ---------------------------------------- | -------------------------------------------- |
| `.`            | `./dist/index.mjs`<br>`./dist/index.cjs` | `./dist/index.d.mts`<br>`./dist/index.d.cts` |

## @bsv/auth-express-middleware

- Package documentation: [docs/packages/middleware/auth-express-middleware.md](../packages/middleware/auth-express-middleware.md)
- Source: [packages/middleware/auth-express-middleware](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth-express-middleware)
- Release note: Standardizes package quality and strengthens authenticated Express session, edge-policy, and error-handling boundaries.
- Migration: No consumer migration is required; existing public CORS defaults and middleware APIs are retained.

| Public subpath   | Runtime target(s)                    | Declaration target(s)                    |
| ---------------- | ------------------------------------ | ---------------------------------------- |
| `.`              | `./dist/mod.mjs`<br>`./dist/mod.cjs` | `./dist/mod.d.mts`<br>`./dist/mod.d.cts` |
| `./package.json` | `./package.json`                     | —                                        |

## @bsv/authsocket

- Package documentation: [docs/packages/messaging/authsocket.md](../packages/messaging/authsocket.md)
- Source: [packages/messaging/authsocket](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/authsocket)
- Release note: Adds an idempotent server shutdown API that closes authenticated sockets and the attached HTTP listener.
- Migration: No existing behavior changes automatically; service owners can call await server.close() during graceful shutdown.

| Public subpath   | Runtime target(s)                    | Declaration target(s)                    |
| ---------------- | ------------------------------------ | ---------------------------------------- |
| `.`              | `./dist/mod.mjs`<br>`./dist/mod.cjs` | `./dist/mod.d.mts`<br>`./dist/mod.d.cts` |
| `./package.json` | `./package.json`                     | —                                        |

## @bsv/authsocket-client

- Package documentation: [docs/packages/messaging/authsocket-client.md](../packages/messaging/authsocket-client.md)
- Source: [packages/messaging/authsocket-client](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/authsocket-client)
- Release note: The source manifest matches the published package; no unpublished release candidate exists.
- Migration: No migration is pending for the current source version.

| Public subpath   | Runtime target(s)                   | Declaration target(s)                   |
| ---------------- | ----------------------------------- | --------------------------------------- |
| `.`              | `./dist/mod.js`<br>`./dist/mod.cjs` | `./dist/mod.d.ts`<br>`./dist/mod.d.cts` |
| `./package.json` | `./package.json`                    | —                                       |

## @bsv/btms

- Package documentation: [docs/packages/wallet/btms.md](../packages/wallet/btms.md)
- Source: [packages/wallet/btms](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/btms)
- Release note: Adds strict package contracts and hardens untrusted-key accounting and token-manager maintainability.
- Migration: No consumer migration is required; token and lookup wire contracts are unchanged.

| Public subpath | Runtime target(s)                        | Declaration target(s)                        |
| -------------- | ---------------------------------------- | -------------------------------------------- |
| `.`            | `./dist/index.mjs`<br>`./dist/index.cjs` | `./dist/index.d.mts`<br>`./dist/index.d.cts` |

## @bsv/btms-permission-module

- Package documentation: [docs/packages/wallet/btms-permission-module.md](../packages/wallet/btms-permission-module.md)
- Source: [packages/wallet/btms-permission-module](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/btms-permission-module)
- Release note: The source manifest matches the published package; no unpublished release candidate exists.
- Migration: No migration is pending for the current source version.

| Public subpath | Runtime target(s)  | Declaration target(s) |
| -------------- | ------------------ | --------------------- |
| `.`            | `./dist/index.mjs` | `./dist/index.d.mts`  |

## @bsv/did

- Package documentation: [docs/packages/helpers/did.md](../packages/helpers/did.md)
- Source: [packages/helpers/did](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/did)
- Release note: The source manifest matches the published package; no unpublished release candidate exists.
- Migration: No migration is pending for the current source version.

| Public subpath | Runtime target(s)                       | Declaration target(s)                       |
| -------------- | --------------------------------------- | ------------------------------------------- |
| `.`            | `./dist/mod.js`<br>`./dist/mod.cjs`     | `./dist/mod.d.ts`<br>`./dist/mod.d.cts`     |
| `./*.ts`       | `./dist/src/*.js`<br>`./dist/src/*.cjs` | `./dist/src/*.d.ts`<br>`./dist/src/*.d.cts` |

## @bsv/did-client

- Package documentation: [docs/packages/helpers/did-client.md](../packages/helpers/did-client.md)
- Source: [packages/helpers/did-client](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/did-client)
- Release note: The source manifest matches the published package; no unpublished release candidate exists.
- Migration: No migration is pending for the current source version.

| Public subpath   | Runtime target(s)                       | Declaration target(s)                       |
| ---------------- | --------------------------------------- | ------------------------------------------- |
| `.`              | `./dist/mod.js`<br>`./dist/mod.cjs`     | `./dist/mod.d.ts`<br>`./dist/mod.d.cts`     |
| `./*.ts`         | `./dist/src/*.js`<br>`./dist/src/*.cjs` | `./dist/src/*.d.ts`<br>`./dist/src/*.d.cts` |
| `./package.json` | `./package.json`                        | —                                           |

## @bsv/fund-wallet

- Package documentation: [docs/packages/helpers/fund-wallet.md](../packages/helpers/fund-wallet.md)
- Source: [packages/helpers/fund-wallet](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/fund-wallet)
- Release note: The source manifest matches the published package; no unpublished release candidate exists.
- Migration: No migration is pending for the current source version.

CLI entry points: `{"fund-metanet":"./dist/index.mjs"}`.

| Public subpath | Runtime target(s) | Declaration target(s) |
| -------------- | ----------------- | --------------------- |
| `.`            | —                 | —                     |

## @bsv/gasp

- Package documentation: [docs/packages/overlays/gasp.md](../packages/overlays/gasp.md)
- Source: [packages/overlays/gasp-core](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/gasp-core)
- Release note: Preserves the positional GASP constructor contract while improving declaration metadata and production maintainability.
- Migration: No consumer migration is required; existing constructor calls and synchronization behavior are unchanged.

| Public subpath | Runtime target(s)                              | Declaration target(s)                                |
| -------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `.`            | `./dist/esm/mod.js`<br>`./dist/cjs/mod.js`     | `./dist/types/mod.d.ts`<br>`./dist/cjs/mod.d.ts`     |
| `./*.ts`       | `./dist/esm/src/*.js`<br>`./dist/cjs/src/*.js` | `./dist/types/src/*.d.ts`<br>`./dist/cjs/src/*.d.ts` |

## @bsv/message-box-client

- Package documentation: [docs/packages/messaging/message-box-client.md](../packages/messaging/message-box-client.md)
- Source: [packages/messaging/message-box-client](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/message-box-client)
- Release note: Adds strict package contracts and hardens PeerPay parsing, proof handling, cancellation, classification, and acknowledgement flows.
- Migration: No consumer migration is required; Message Box protocol and client entry points are unchanged.

| Public subpath   | Runtime target(s)                   | Declaration target(s)                   |
| ---------------- | ----------------------------------- | --------------------------------------- |
| `.`              | `./dist/mod.js`<br>`./dist/mod.cjs` | `./dist/mod.d.ts`<br>`./dist/mod.d.cts` |
| `./package.json` | `./package.json`                    | —                                       |

## @bsv/overlay

- Package documentation: [docs/packages/overlays/overlay.md](../packages/overlays/overlay.md)
- Source: [packages/overlays/overlay](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/overlay)
- Release note: Repairs the documented storage export and reduces production complexity while preserving Engine and storage behavior.
- Migration: No consumer migration is required; existing imports remain valid and the documented storage subpath is restored.

| Public subpath | Runtime target(s)                                                          | Declaration target(s)                                                            |
| -------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `.`            | `./dist/esm/mod.js`<br>`./dist/cjs/mod.js`                                 | `./dist/types/mod.d.ts`<br>`./dist/cjs/mod.d.ts`                                 |
| `./*.ts`       | `./dist/esm/src/*.js`<br>`./dist/cjs/src/*.js`                             | `./dist/types/src/*.d.ts`<br>`./dist/cjs/src/*.d.ts`                             |
| `./storage`    | `./dist/esm/src/storage/Storage.js`<br>`./dist/cjs/src/storage/Storage.js` | `./dist/types/src/storage/Storage.d.ts`<br>`./dist/cjs/src/storage/Storage.d.ts` |
| `./storage/*`  | `./dist/esm/src/storage/*.js`<br>`./dist/cjs/src/storage/*.js`             | `./dist/types/src/storage/*.d.ts`<br>`./dist/cjs/src/storage/*.d.ts`             |

## @bsv/overlay-discovery-services

- Package documentation: [docs/packages/overlays/overlay-discovery-services.md](../packages/overlays/overlay-discovery-services.md)
- Source: [packages/overlays/overlay-discovery-services](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/overlay-discovery-services)
- Release note: Hardens discovery URI, registry and lookup validation, preserves the historical lookup error class, and reduces production duplication.
- Migration: No consumer migration is required; discovery records and public network behavior are unchanged.

| Public subpath | Runtime target(s)                              | Declaration target(s)                                |
| -------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `.`            | `./dist/esm/mod.js`<br>`./dist/cjs/mod.js`     | `./dist/types/mod.d.ts`<br>`./dist/cjs/mod.d.ts`     |
| `./*.ts`       | `./dist/esm/src/*.js`<br>`./dist/cjs/src/*.js` | `./dist/types/src/*.d.ts`<br>`./dist/cjs/src/*.d.ts` |

## @bsv/overlay-express

- Package documentation: [docs/packages/overlays/overlay-express.md](../packages/overlays/overlay-express.md)
- Source: [packages/overlays/overlay-express](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/overlay-express)
- Release note: Adds strict package and edge-policy contracts, restores declaration-safe exports, adds idempotent shutdown, and hardens provider-chain failure handling and synchronization configuration.
- Migration: No consumer migration is required; wildcard credential-free public access remains the default and runtimes may opt into the new close method.

| Public subpath | Runtime target(s)                              | Declaration target(s)                                |
| -------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `.`            | `./dist/esm/mod.js`<br>`./dist/cjs/mod.js`     | `./dist/types/mod.d.ts`<br>`./dist/cjs/mod.d.ts`     |
| `./*.ts`       | `./dist/esm/src/*.js`<br>`./dist/cjs/src/*.js` | `./dist/types/src/*.d.ts`<br>`./dist/cjs/src/*.d.ts` |

## @bsv/overlay-topics

- Package documentation: [docs/packages/overlays/overlay-topics.md](../packages/overlays/overlay-topics.md)
- Source: [packages/overlays/topics](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/topics)
- Release note: Hardens registry, discovery, supply-chain validation, and concurrent index initialization while reducing topic and lookup production complexity.
- Migration: No consumer migration is required; topic IDs, lookup contracts, and persisted formats are unchanged.

| Public subpath | Runtime target(s)                      | Declaration target(s) |
| -------------- | -------------------------------------- | --------------------- |
| `.`            | `./dist/index.js`<br>`./dist/index.js` | `./dist/index.d.ts`   |

## @bsv/paymail

- Package documentation: [docs/packages/messaging/paymail.md](../packages/messaging/paymail.md)
- Source: [packages/messaging/ts-paymail](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/ts-paymail)
- Release note: Modernizes the package contract and hardens DNS, capability discovery, and browser-compatible Paymail behavior.
- Migration: No consumer migration is required; existing Paymail client APIs and protocol semantics are retained.

| Public subpath   | Runtime target(s)                                                           | Declaration target(s)                                                           |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `.`              | `./dist/mod.browser.js`<br>`./dist/mod.js`<br>`./dist/mod.cjs`              | `./dist/mod.browser.d.ts`<br>`./dist/mod.d.ts`<br>`./dist/mod.d.cts`            |
| `./client`       | `./dist/src/paymailClient/index.js`<br>`./dist/src/paymailClient/index.cjs` | `./dist/src/paymailClient/index.d.ts`<br>`./dist/src/paymailClient/index.d.cts` |
| `./client/*`     | `./dist/src/paymailClient/*.js`<br>`./dist/src/paymailClient/*.cjs`         | `./dist/src/paymailClient/*.d.ts`<br>`./dist/src/paymailClient/*.d.cts`         |
| `./capability`   | `./dist/src/capability/index.js`<br>`./dist/src/capability/index.cjs`       | `./dist/src/capability/index.d.ts`<br>`./dist/src/capability/index.d.cts`       |
| `./capability/*` | `./dist/src/capability/*.js`<br>`./dist/src/capability/*.cjs`               | `./dist/src/capability/*.d.ts`<br>`./dist/src/capability/*.d.cts`               |
| `./router`       | `./dist/src/paymailRouter/index.js`<br>`./dist/src/paymailRouter/index.cjs` | `./dist/src/paymailRouter/index.d.ts`<br>`./dist/src/paymailRouter/index.d.cts` |
| `./router/*`     | `./dist/src/paymailRouter/*.js`<br>`./dist/src/paymailRouter/*.cjs`         | `./dist/src/paymailRouter/*.d.ts`<br>`./dist/src/paymailRouter/*.d.cts`         |
| `./errors`       | `./dist/src/errors/index.js`<br>`./dist/src/errors/index.cjs`               | `./dist/src/errors/index.d.ts`<br>`./dist/src/errors/index.d.cts`               |
| `./errors/*`     | `./dist/src/errors/*.js`<br>`./dist/src/errors/*.cjs`                       | `./dist/src/errors/*.d.ts`<br>`./dist/src/errors/*.d.cts`                       |
| `./package.json` | `./package.json`                                                            | —                                                                               |

## @bsv/payment-express-middleware

- Package documentation: [docs/packages/middleware/payment-express-middleware.md](../packages/middleware/payment-express-middleware.md)
- Source: [packages/middleware/payment-express-middleware](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/payment-express-middleware)
- Release note: Standardizes package quality and strengthens payment middleware validation, edge policy, and failure handling.
- Migration: No consumer migration is required; legacy x-bsv-payment JSON behavior remains supported.

| Public subpath   | Runtime target(s)                    | Declaration target(s)                    |
| ---------------- | ------------------------------------ | ---------------------------------------- |
| `.`              | `./dist/mod.mjs`<br>`./dist/mod.cjs` | `./dist/mod.d.mts`<br>`./dist/mod.d.cts` |
| `./package.json` | `./package.json`                     | —                                        |

## @bsv/sdk

- Package documentation: [docs/packages/sdk/bsv-sdk.md](../packages/sdk/bsv-sdk.md)
- Source: [packages/sdk](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/sdk)
- Release note: Accumulates security and correctness hardening, transaction and action-batch performance work, strict package contracts, safer text and telemetry handling, and behavior-preserving production maintainability remediation.
- Migration: No consumer migration is required; the source candidate preserves the 2.x public API and supported import forms.

| Public subpath                  | Runtime target(s)                                                                                          | Declaration target(s)                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `.`                             | `./dist/esm/mod.js`<br>`./dist/cjs/mod.js`                                                                 | `./dist/types/mod.d.ts`<br>`./dist/cjs/mod.d.ts`                                                                 |
| `./*.ts`                        | `./dist/esm/src/*.js`<br>`./dist/cjs/src/*.js`                                                             | `./dist/types/src/*.d.ts`<br>`./dist/cjs/src/*.d.ts`                                                             |
| `./primitives`                  | `./dist/esm/src/primitives/index.js`<br>`./dist/cjs/src/primitives/index.js`                               | `./dist/types/src/primitives/index.d.ts`<br>`./dist/cjs/src/primitives/index.d.ts`                               |
| `./primitives/*`                | `./dist/esm/src/primitives/*.js`<br>`./dist/cjs/src/primitives/*.js`                                       | `./dist/types/src/primitives/*.d.ts`<br>`./dist/cjs/src/primitives/*.d.ts`                                       |
| `./script`                      | `./dist/esm/src/script/index.js`<br>`./dist/cjs/src/script/index.js`                                       | `./dist/types/src/script/index.d.ts`<br>`./dist/cjs/src/script/index.d.ts`                                       |
| `./script/*`                    | `./dist/esm/src/script/*.js`<br>`./dist/cjs/src/script/*.js`                                               | `./dist/types/src/script/*.d.ts`<br>`./dist/cjs/src/script/*.d.ts`                                               |
| `./script/templates`            | `./dist/esm/src/script/templates/index.js`<br>`./dist/cjs/src/script/templates/index.js`                   | `./dist/types/src/script/templates/index.d.ts`<br>`./dist/cjs/src/script/templates/index.d.ts`                   |
| `./script/templates/*`          | `./dist/esm/src/script/templates/*.js`<br>`./dist/cjs/src/script/templates/*.js`                           | `./dist/types/src/script/templates/*.d.ts`<br>`./dist/cjs/src/script/templates/*.d.ts`                           |
| `./transaction`                 | `./dist/esm/src/transaction/index.js`<br>`./dist/cjs/src/transaction/index.js`                             | `./dist/types/src/transaction/index.d.ts`<br>`./dist/cjs/src/transaction/index.d.ts`                             |
| `./transaction/*`               | `./dist/esm/src/transaction/*.js`<br>`./dist/cjs/src/transaction/*.js`                                     | `./dist/types/src/transaction/*.d.ts`<br>`./dist/cjs/src/transaction/*.d.ts`                                     |
| `./transaction/broadcaster`     | `./dist/esm/src/transaction/broadcasters/index.js`<br>`./dist/cjs/src/transaction/broadcasters/index.js`   | `./dist/types/src/transaction/broadcasters/index.d.ts`<br>`./dist/cjs/src/transaction/broadcasters/index.d.ts`   |
| `./transaction/broadcaster/*`   | `./dist/esm/src/transaction/broadcasters/*.js`<br>`./dist/cjs/src/transaction/broadcasters/*.js`           | `./dist/types/src/transaction/broadcasters/*.d.ts`<br>`./dist/cjs/src/transaction/broadcasters/*.d.ts`           |
| `./transaction/broadcasters`    | `./dist/esm/src/transaction/broadcasters/index.js`<br>`./dist/cjs/src/transaction/broadcasters/index.js`   | `./dist/types/src/transaction/broadcasters/index.d.ts`<br>`./dist/cjs/src/transaction/broadcasters/index.d.ts`   |
| `./transaction/broadcasters/*`  | `./dist/esm/src/transaction/broadcasters/*.js`<br>`./dist/cjs/src/transaction/broadcasters/*.js`           | `./dist/types/src/transaction/broadcasters/*.d.ts`<br>`./dist/cjs/src/transaction/broadcasters/*.d.ts`           |
| `./transaction/chaintrackers`   | `./dist/esm/src/transaction/chaintrackers/index.js`<br>`./dist/cjs/src/transaction/chaintrackers/index.js` | `./dist/types/src/transaction/chaintrackers/index.d.ts`<br>`./dist/cjs/src/transaction/chaintrackers/index.d.ts` |
| `./transaction/chaintrackers/*` | `./dist/esm/src/transaction/chaintrackers/*.js`<br>`./dist/cjs/src/transaction/chaintrackers/*.js`         | `./dist/types/src/transaction/chaintrackers/*.d.ts`<br>`./dist/cjs/src/transaction/chaintrackers/*.d.ts`         |
| `./transaction/http`            | `./dist/esm/src/transaction/http/index.js`<br>`./dist/cjs/src/transaction/http/index.js`                   | `./dist/types/src/transaction/http/index.d.ts`<br>`./dist/cjs/src/transaction/http/index.d.ts`                   |
| `./transaction/http/*`          | `./dist/esm/src/transaction/http/*.js`<br>`./dist/cjs/src/transaction/http/*.js`                           | `./dist/types/src/transaction/http/*.d.ts`<br>`./dist/cjs/src/transaction/http/*.d.ts`                           |
| `./transaction/fee-model`       | `./dist/esm/src/transaction/fee-models/index.js`<br>`./dist/cjs/src/transaction/fee-models/index.js`       | `./dist/types/src/transaction/fee-models/index.d.ts`<br>`./dist/cjs/src/transaction/fee-models/index.d.ts`       |
| `./transaction/fee-model/*`     | `./dist/esm/src/transaction/fee-models/*.js`<br>`./dist/cjs/src/transaction/fee-models/*.js`               | `./dist/types/src/transaction/fee-models/*.d.ts`<br>`./dist/cjs/src/transaction/fee-models/*.d.ts`               |
| `./transaction/fee-models`      | `./dist/esm/src/transaction/fee-models/index.js`<br>`./dist/cjs/src/transaction/fee-models/index.js`       | `./dist/types/src/transaction/fee-models/index.d.ts`<br>`./dist/cjs/src/transaction/fee-models/index.d.ts`       |
| `./transaction/fee-models/*`    | `./dist/esm/src/transaction/fee-models/*.js`<br>`./dist/cjs/src/transaction/fee-models/*.js`               | `./dist/types/src/transaction/fee-models/*.d.ts`<br>`./dist/cjs/src/transaction/fee-models/*.d.ts`               |
| `./messages`                    | `./dist/esm/src/messages/index.js`<br>`./dist/cjs/src/messages/index.js`                                   | `./dist/types/src/messages/index.d.ts`<br>`./dist/cjs/src/messages/index.d.ts`                                   |
| `./messages/*`                  | `./dist/esm/src/messages/*.js`<br>`./dist/cjs/src/messages/*.js`                                           | `./dist/types/src/messages/*.d.ts`<br>`./dist/cjs/src/messages/*.d.ts`                                           |
| `./compat`                      | `./dist/esm/src/compat/index.js`<br>`./dist/cjs/src/compat/index.js`                                       | `./dist/types/src/compat/index.d.ts`<br>`./dist/cjs/src/compat/index.d.ts`                                       |
| `./compat/*`                    | `./dist/esm/src/compat/*.js`<br>`./dist/cjs/src/compat/*.js`                                               | `./dist/types/src/compat/*.d.ts`<br>`./dist/cjs/src/compat/*.d.ts`                                               |
| `./totp`                        | `./dist/esm/src/totp/index.js`<br>`./dist/cjs/src/totp/index.js`                                           | `./dist/types/src/totp/index.d.ts`<br>`./dist/cjs/src/totp/index.d.ts`                                           |
| `./totp/*`                      | `./dist/esm/src/totp/*.js`<br>`./dist/cjs/src/totp/*.js`                                                   | `./dist/types/src/totp/*.d.ts`<br>`./dist/cjs/src/totp/*.d.ts`                                                   |
| `./wallet`                      | `./dist/esm/src/wallet/index.js`<br>`./dist/cjs/src/wallet/index.js`                                       | `./dist/types/src/wallet/index.d.ts`<br>`./dist/cjs/src/wallet/index.d.ts`                                       |
| `./wallet/*`                    | `./dist/esm/src/wallet/*.js`<br>`./dist/cjs/src/wallet/*.js`                                               | `./dist/types/src/wallet/*.d.ts`<br>`./dist/cjs/src/wallet/*.d.ts`                                               |
| `./wallet/substrates`           | `./dist/esm/src/wallet/substrates/index.js`<br>`./dist/cjs/src/wallet/substrates/index.js`                 | `./dist/types/src/wallet/substrates/index.d.ts`<br>`./dist/cjs/src/wallet/substrates/index.d.ts`                 |
| `./wallet/substrates/*`         | `./dist/esm/src/wallet/substrates/*.js`<br>`./dist/cjs/src/wallet/substrates/*.js`                         | `./dist/types/src/wallet/substrates/*.d.ts`<br>`./dist/cjs/src/wallet/substrates/*.d.ts`                         |
| `./auth`                        | `./dist/esm/src/auth/index.js`<br>`./dist/cjs/src/auth/index.js`                                           | `./dist/types/src/auth/index.d.ts`<br>`./dist/cjs/src/auth/index.d.ts`                                           |
| `./auth/*`                      | `./dist/esm/src/auth/*.js`<br>`./dist/cjs/src/auth/*.js`                                                   | `./dist/types/src/auth/*.d.ts`<br>`./dist/cjs/src/auth/*.d.ts`                                                   |
| `./auth/certificate`            | `./dist/esm/src/auth/certificates/index.js`<br>`./dist/cjs/src/auth/certificates/index.js`                 | `./dist/types/src/auth/certificates/index.d.ts`<br>`./dist/cjs/src/auth/certificates/index.d.ts`                 |
| `./auth/certificate/*`          | `./dist/esm/src/auth/certificates/*.js`<br>`./dist/cjs/src/auth/certificates/*.js`                         | `./dist/types/src/auth/certificates/*.d.ts`<br>`./dist/cjs/src/auth/certificates/*.d.ts`                         |
| `./auth/certificates`           | `./dist/esm/src/auth/certificates/index.js`<br>`./dist/cjs/src/auth/certificates/index.js`                 | `./dist/types/src/auth/certificates/index.d.ts`<br>`./dist/cjs/src/auth/certificates/index.d.ts`                 |
| `./auth/certificates/*`         | `./dist/esm/src/auth/certificates/*.js`<br>`./dist/cjs/src/auth/certificates/*.js`                         | `./dist/types/src/auth/certificates/*.d.ts`<br>`./dist/cjs/src/auth/certificates/*.d.ts`                         |
| `./overlay-tools`               | `./dist/esm/src/overlay-tools/index.js`<br>`./dist/cjs/src/overlay-tools/index.js`                         | `./dist/types/src/overlay-tools/index.d.ts`<br>`./dist/cjs/src/overlay-tools/index.d.ts`                         |
| `./overlay-tools/*`             | `./dist/esm/src/overlay-tools/*.js`<br>`./dist/cjs/src/overlay-tools/*.js`                                 | `./dist/types/src/overlay-tools/*.d.ts`<br>`./dist/cjs/src/overlay-tools/*.d.ts`                                 |
| `./telemetry`                   | `./dist/esm/src/telemetry/index.js`<br>`./dist/cjs/src/telemetry/index.js`                                 | `./dist/types/src/telemetry/index.d.ts`<br>`./dist/cjs/src/telemetry/index.d.ts`                                 |
| `./telemetry/*`                 | `./dist/esm/src/telemetry/*.js`<br>`./dist/cjs/src/telemetry/*.js`                                         | `./dist/types/src/telemetry/*.d.ts`<br>`./dist/cjs/src/telemetry/*.d.ts`                                         |
| `./storage`                     | `./dist/esm/src/storage/index.js`<br>`./dist/cjs/src/storage/index.js`                                     | `./dist/types/src/storage/index.d.ts`<br>`./dist/cjs/src/storage/index.d.ts`                                     |
| `./storage/*`                   | `./dist/esm/src/storage/*.js`<br>`./dist/cjs/src/storage/*.js`                                             | `./dist/types/src/storage/*.d.ts`<br>`./dist/cjs/src/storage/*.d.ts`                                             |
| `./kvstore`                     | `./dist/esm/src/kvstore/index.js`<br>`./dist/cjs/src/kvstore/index.js`                                     | `./dist/types/src/kvstore/index.d.ts`<br>`./dist/cjs/src/kvstore/index.d.ts`                                     |
| `./kvstore/*`                   | `./dist/esm/src/kvstore/*.js`<br>`./dist/cjs/src/kvstore/*.js`                                             | `./dist/types/src/kvstore/*.d.ts`<br>`./dist/cjs/src/kvstore/*.d.ts`                                             |
| `./remittance`                  | `./dist/esm/src/remittance/index.js`<br>`./dist/cjs/src/remittance/index.js`                               | `./dist/types/src/remittance/index.d.ts`<br>`./dist/cjs/src/remittance/index.d.ts`                               |
| `./remittance/*`                | `./dist/esm/src/remittance/*.js`<br>`./dist/cjs/src/remittance/*.js`                                       | `./dist/types/src/remittance/*.d.ts`<br>`./dist/cjs/src/remittance/*.d.ts`                                       |
| `./umd`                         | `./dist/umd/bundle.js`                                                                                     | `./dist/types/mod.d.ts`                                                                                          |

## @bsv/simple

- Package documentation: [docs/packages/helpers/simple.md](../packages/helpers/simple.md)
- Source: [packages/helpers/simple](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/simple)
- Release note: Adds strict browser and server package contracts and hardens wallet construction, naming clarity, output handling, and error behavior.
- Migration: No consumer migration is required; the browser and server entry points remain compatible.

| Public subpath | Runtime target(s)                            | Declaration target(s)                            |
| -------------- | -------------------------------------------- | ------------------------------------------------ |
| `.`            | `./dist/index.mjs`<br>`./dist/index.cjs`     | `./dist/index.d.mts`<br>`./dist/index.d.cts`     |
| `./browser`    | `./dist/browser.mjs`<br>`./dist/browser.cjs` | `./dist/browser.d.mts`<br>`./dist/browser.d.cts` |
| `./server`     | `./dist/server.mjs`<br>`./dist/server.cjs`   | `./dist/server.d.mts`<br>`./dist/server.d.cts`   |

## @bsv/templates

- Package documentation: [docs/packages/helpers/templates.md](../packages/helpers/templates.md)
- Source: [packages/helpers/ts-templates](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/ts-templates)
- Release note: Consolidates MultiPushDrop script construction while preserving the exact generated locking-script sequence.
- Migration: No consumer migration is required; template APIs and generated script semantics are unchanged.

| Public subpath | Runtime target(s)                       | Declaration target(s)                       |
| -------------- | --------------------------------------- | ------------------------------------------- |
| `.`            | `./dist/mod.js`<br>`./dist/mod.cjs`     | `./dist/mod.d.ts`<br>`./dist/mod.d.cts`     |
| `./*.ts`       | `./dist/src/*.js`<br>`./dist/src/*.cjs` | `./dist/src/*.d.ts`<br>`./dist/src/*.d.cts` |

## @bsv/teranode-listener

- Package documentation: [docs/packages/network/teranode-listener.md](../packages/network/teranode-listener.md)
- Source: [packages/network/ts-p2p](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/network/ts-p2p)
- Release note: Refreshes the compatible libp2p transport, discovery, identification, DHT, peer-ID, ping, and private-network dependency set.
- Migration: No consumer migration is required; listener APIs, topics, and network configuration are unchanged.

| Public subpath   | Runtime target(s)                      | Declaration target(s) |
| ---------------- | -------------------------------------- | --------------------- |
| `.`              | `./dist/index.js`<br>`./dist/index.js` | `./dist/index.d.ts`   |
| `./package.json` | `./package.json`                       | —                     |

## @bsv/verifast

- Package documentation: [docs/packages/sdk/verifast.md](../packages/sdk/verifast.md)
- Source: [packages/verifast](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/verifast)
- Release note: Uses precise worker result type errors and refreshes the compatible browser verification test client.
- Migration: No consumer migration is required; valid verification results and worker protocols are unchanged.

| Public subpath             | Runtime target(s)                                                                           | Declaration target(s)                                                |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `.`                        | `./dist/mod.browser.js`<br>`./dist/mod.js`<br>`./dist/cjs/mod.cjs`<br>`./dist/mod.js`       | `./dist/mod.browser.d.ts`<br>`./dist/mod.d.ts`<br>`./dist/mod.d.cts` |
| `./umd`                    | `./dist/umd/verifast.js`<br>`./dist/umd.js`<br>`./dist/umd/verifast.cjs`<br>`./dist/umd.js` | `./dist/umd.d.ts`<br>`./dist/umd.d.cts`                              |
| `./wasm/bdk-core.umd.js`   | `./dist/src/wasm/bdk-core.umd.js`                                                           | —                                                                    |
| `./wasm/bdk-core.umd.wasm` | `./dist/src/wasm/bdk-core.umd.wasm`                                                         | —                                                                    |
| `./wasm/bdk-core.wasm`     | `./dist/src/wasm/bdk-core.wasm`                                                             | —                                                                    |

## @bsv/wallet-helper

- Package documentation: [docs/packages/helpers/wallet-helper.md](../packages/helpers/wallet-helper.md)
- Source: [packages/helpers/bsv-wallet-helper](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/bsv-wallet-helper)
- Release note: Adds strict package contracts and hardens transaction-builder and OP_RETURN validation behavior.
- Migration: No consumer migration is required; fluent builder APIs and transaction semantics are unchanged.

| Public subpath | Runtime target(s)                        | Declaration target(s)                        |
| -------------- | ---------------------------------------- | -------------------------------------------- |
| `.`            | `./dist/index.mjs`<br>`./dist/index.cjs` | `./dist/index.d.mts`<br>`./dist/index.d.cts` |

## @bsv/wallet-relay

- Package documentation: [docs/packages/wallet/wallet-relay.md](../packages/wallet/wallet-relay.md)
- Source: [packages/wallet/ts-wallet-relay](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/ts-wallet-relay)
- Release note: Adds the strict package and artifact contract and strengthens relay runtime, declaration consistency, native QR accessibility, and CLI control flow.
- Migration: QRPairingCode now renders a native button and accepts button wrapper attributes. Existing className, style, data, and ARIA props continue to work; update div-specific wrapper selectors or explicitly typed div event handlers.

CLI entry points: `{"wallet-relay":"./bin/init.mjs"}`.

| Public subpath   | Runtime target(s)                         | Declaration target(s)                         |
| ---------------- | ----------------------------------------- | --------------------------------------------- |
| `.`              | `./dist/index.js`<br>`./dist/index.cjs`   | `./dist/index.d.ts`<br>`./dist/index.d.cts`   |
| `./client`       | `./dist/client.js`<br>`./dist/client.cjs` | `./dist/client.d.ts`<br>`./dist/client.d.cts` |
| `./react`        | `./dist/react.js`<br>`./dist/react.cjs`   | `./dist/react.d.ts`<br>`./dist/react.d.cts`   |
| `./package.json` | `./package.json`                          | —                                             |

## @bsv/wallet-toolbox

- Package documentation: [docs/packages/wallet/wallet-toolbox.md](../packages/wallet/wallet-toolbox.md)
- Source: [packages/wallet/wallet-toolbox](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox)
- Release note: Adds atomic action-batch transport, storage and proof resilience, security hardening, compatible runtime dependency maintenance, strict package contracts, and broad production maintainability and initialization improvements.
- Migration: No consumer migration is required; persisted schemas and the 2.x wallet and storage interfaces remain compatible.

| Public subpath   | Runtime target(s)                                    | Declaration target(s)      |
| ---------------- | ---------------------------------------------------- | -------------------------- |
| `.`              | `./out/src/index.js`<br>`./out/src/index.js`         | `./out/src/index.d.ts`     |
| `./out/src/sdk`  | `./out/src/sdk/index.js`<br>`./out/src/sdk/index.js` | `./out/src/sdk/index.d.ts` |
| `./out/src/*`    | `./out/src/*.js`                                     | `./out/src/*.d.ts`         |
| `./package.json` | `./package.json`                                     | —                          |

## @bsv/wallet-toolbox-client

- Package documentation: [docs/packages/wallet/wallet-toolbox-client.md](../packages/wallet/wallet-toolbox-client.md)
- Source: [packages/wallet/wallet-toolbox/client](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/client)
- Release note: Carries the lockstep Wallet Toolbox client candidate with transport, validation, dependency, package, and declaration hardening.
- Migration: No consumer migration is required; client entry points and remote storage contracts remain compatible.

| Public subpath   | Runtime target(s)                                                                | Declaration target(s)                                                                  |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `.`              | `./out/index.client.mjs`<br>`./out/index.client.mjs`<br>`./out/index.client.cjs` | `./out/index.client.d.mts`<br>`./out/index.client.d.mts`<br>`./out/index.client.d.cts` |
| `./package.json` | `./package.json`                                                                 | —                                                                                      |

## @bsv/wallet-toolbox-mobile

- Package documentation: [docs/packages/wallet/wallet-toolbox-mobile.md](../packages/wallet/wallet-toolbox-mobile.md)
- Source: [packages/wallet/wallet-toolbox/mobile](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox/mobile)
- Release note: Carries the lockstep Wallet Toolbox mobile candidate with platform, React Native preset, package, declaration, and transport hardening.
- Migration: No consumer migration is required; React Native and mobile bridge contracts remain compatible.

| Public subpath   | Runtime target(s)                                                                | Declaration target(s)                                                                  |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `.`              | `./out/index.mobile.mjs`<br>`./out/index.mobile.mjs`<br>`./out/index.mobile.cjs` | `./out/index.mobile.d.mts`<br>`./out/index.mobile.d.mts`<br>`./out/index.mobile.d.cts` |
| `./package.json` | `./package.json`                                                                 | —                                                                                      |

## create-bsv-app

- Package documentation: [docs/packages/helpers/create-bsv-app.md](../packages/helpers/create-bsv-app.md)
- Source: [packages/helpers/create-bsv-app](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/create-bsv-app)
- Release note: The source manifest matches the published package; no unpublished release candidate exists.
- Migration: No migration is pending for the current source version.

CLI entry points: `{"create-bsv-app":"dist/index.js"}`.

| Public subpath | Runtime target(s) | Declaration target(s) |
| -------------- | ----------------- | --------------------- |
| `.`            | `./dist/index.js` | `./dist/index.d.ts`   |

## Change procedure

1. Change the public package and select the SemVer impact from its packed API,
   runtime, wire, persistence, and declaration changes.
2. Bump only affected package manifests and first-party dependents whose packed
   contract changes.
3. Update the matching entry in
   `governance/package-release-notes.json`, including explicit migration
   guidance even when no consumer action is required.
4. Run `pnpm docs:packages`, `pnpm docs:packages:check`,
   `pnpm check-versions`, packed-consumer checks, and the full release gates.
5. After an authorized publication, update `publishedVersion` to the registry
   result and set `releaseType` to `none` only when source and npm match.
