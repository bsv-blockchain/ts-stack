# ts-stack

BSV TypeScript monorepo — all production TypeScript packages for the BSV blockchain stack, organised by domain.

[![CI](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml/badge.svg)](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml)

## Domains

| Domain | Path | Packages |
|--------|------|----------|
| **SDK** | `packages/sdk/` | 3 |
| **Wallet** | `packages/wallet/` | 9 |
| **Network** | `packages/network/` | 1 |
| **Overlays** | `packages/overlays/` | 10 |
| **Messaging** | `packages/messaging/` | 6 |
| **Middleware** | `packages/middleware/` | 3 |
| **Helpers** | `packages/helpers/` | 4 |
| **Conformance** | `conformance/` | 1 runner |

**35 packages** + conformance runner across 7 domains.

---

## Package Map

### SDK — `packages/sdk/`
| Package | npm |
|---------|-----|
| [ts-sdk](packages/sdk/ts-sdk) | [@bsv/sdk](https://www.npmjs.com/package/@bsv/sdk) |
| [ts-templates](packages/sdk/ts-templates) | [@bsv/templates](https://www.npmjs.com/package/@bsv/templates) |

### Wallet — `packages/wallet/`
| Package | npm |
|---------|-----|
| [wallet-toolbox](packages/wallet/wallet-toolbox) | [@bsv/wallet-toolbox](https://www.npmjs.com/package/@bsv/wallet-toolbox) |
| [wallet-toolbox/client](packages/wallet/wallet-toolbox/client) | [@bsv/wallet-toolbox-client](https://www.npmjs.com/package/@bsv/wallet-toolbox-client) |
| [wallet-toolbox/mobile](packages/wallet/wallet-toolbox/mobile) | [@bsv/wallet-toolbox-mobile](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile) |
| [wallet-toolbox-examples](packages/wallet/wallet-toolbox-examples) | `@bsv/wallet-toolbox-examples` *(private)* |
| [wallet-infra](packages/wallet/wallet-infra) | `@bsv/wallet-infra` *(private)* |
| [ts-wallet-relay](packages/wallet/ts-wallet-relay) | [@bsv/wallet-relay](https://www.npmjs.com/package/@bsv/wallet-relay) |
| [btms](packages/wallet/btms) | [@bsv/btms](https://www.npmjs.com/package/@bsv/btms) |
| [btms-permission-module](packages/wallet/btms-permission-module) | [@bsv/btms-permission-module](https://www.npmjs.com/package/@bsv/btms-permission-module) |
| [wab](packages/wallet/wab) | `@bsv/wab-server` *(private)* |

### Network — `packages/network/`
| Package | npm |
|---------|-----|
| [ts-p2p](packages/network/ts-p2p) | [@bsv/teranode-listener](https://www.npmjs.com/package/@bsv/teranode-listener) |

### Overlays — `packages/overlays/`
| Package | npm |
|---------|-----|
| [overlay-services](packages/overlays/overlay-services) | [@bsv/overlay](https://www.npmjs.com/package/@bsv/overlay) |
| [overlay-express](packages/overlays/overlay-express) | [@bsv/overlay-express](https://www.npmjs.com/package/@bsv/overlay-express) |
| [overlay-server](packages/overlays/overlay-server) | `@bsv/overlay-express-examples` *(private)* |
| [overlay-discovery-services](packages/overlays/overlay-discovery-services) | [@bsv/overlay-discovery-services](https://www.npmjs.com/package/@bsv/overlay-discovery-services) |
| [gasp-core](packages/overlays/gasp-core) | [@bsv/gasp](https://www.npmjs.com/package/@bsv/gasp) |
| [storage-server](packages/overlays/storage-server) | [@bsv/uhrp-storage-server](https://www.npmjs.com/package/@bsv/uhrp-storage-server) |
| [lite-storage-server](packages/overlays/lite-storage-server) | `@bsv/uhrp-lite` *(private)* |
| [did-client](packages/overlays/did-client) | [@bsv/did-client](https://www.npmjs.com/package/@bsv/did-client) |
| [btms-backend](packages/overlays/btms-backend) | `@bsv/btms-backend` *(private)* |
| [topics](packages/overlays/topics) | [@bsv/overlay-topics](https://www.npmjs.com/package/@bsv/overlay-topics) |

### Messaging — `packages/messaging/`
| Package | npm |
|---------|-----|
| [message-box-server](packages/messaging/message-box-server) | `@bsv/messagebox-server` *(private)* |
| [message-box-client](packages/messaging/message-box-client) | [@bsv/message-box-client](https://www.npmjs.com/package/@bsv/message-box-client) |
| [messagebox-services](packages/messaging/messagebox-services) | [@bsv/messagebox-services](https://www.npmjs.com/package/@bsv/messagebox-services) |
| [authsocket](packages/messaging/authsocket) | [@bsv/authsocket](https://www.npmjs.com/package/@bsv/authsocket) |
| [authsocket-client](packages/messaging/authsocket-client) | [@bsv/authsocket-client](https://www.npmjs.com/package/@bsv/authsocket-client) |
| [ts-paymail](packages/messaging/ts-paymail) | [@bsv/paymail](https://www.npmjs.com/package/@bsv/paymail) |

### Middleware — `packages/middleware/`
| Package | npm |
|---------|-----|
| [auth-express-middleware](packages/middleware/auth-express-middleware) | [@bsv/auth-express-middleware](https://www.npmjs.com/package/@bsv/auth-express-middleware) |
| [payment-express-middleware](packages/middleware/payment-express-middleware) | [@bsv/payment-express-middleware](https://www.npmjs.com/package/@bsv/payment-express-middleware) |
| [402-pay](packages/middleware/402-pay) | [@bsv/402-pay](https://www.npmjs.com/package/@bsv/402-pay) |

### Helpers — `packages/helpers/`
| Package | npm |
|---------|-----|
| [simple](packages/helpers/simple) | [@bsv/simple](https://www.npmjs.com/package/@bsv/simple) |
| [bsv-wallet-helper](packages/helpers/bsv-wallet-helper) | [@bsv/wallet-helper](https://www.npmjs.com/package/@bsv/wallet-helper) |
| [amountinator](packages/helpers/amountinator) | [@bsv/amountinator](https://www.npmjs.com/package/@bsv/amountinator) |
| [fund-metanet](packages/helpers/fund-metanet) | `@bsv/fund-metanet` *(private)* |

---

## Development

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9

### Setup

```sh
pnpm install
```

### Build all packages

```sh
pnpm -r run build
```

### Test all packages

```sh
pnpm -r run test
```

### Lint all packages

```sh
pnpm -r run lint
```

All packages use [ts-standard](https://github.com/standard/ts-standard) — no separate prettier config.

### Check cross-package version alignment

```sh
pnpm check-versions
```

### Sync stale cross-package version refs

```sh
pnpm sync-versions
```

### Run conformance vectors

```sh
pnpm conformance
```

---

## Architecture

Each domain has a clear boundary. Dependencies only flow inward toward the SDK:

```
Overlays / Messaging / Middleware
         ↓
       Wallet
         ↓
       Network
         ↓
        SDK
```

Helpers are used by any domain. Conformance tests all domains against shared vector sets.

---

## Updating packages (git subtree)

Each package was added via `git subtree` — full commit history is preserved. To pull upstream changes for a package:

```sh
git subtree pull --prefix=packages/sdk/ts-sdk ~/git/ts/ts-sdk master
```

---

## Releasing

Releases use GitHub Actions with npm OIDC provenance — no static token required. Tag a package to trigger publish:

```sh
git tag packages/sdk/ts-sdk/v2.1.0
git push origin packages/sdk/ts-sdk/v2.1.0
```

Each published package must be configured as a trusted publisher on npmjs.org:
- **Owner:** `bsv-blockchain`
- **Repository:** `ts-stack`
- **Workflow:** `release.yml`

---

## License

See individual package directories for license terms.
