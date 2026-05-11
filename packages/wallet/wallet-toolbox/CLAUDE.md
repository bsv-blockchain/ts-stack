# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# @bsv/wallet-toolbox v2.1.24

## Purpose
The Wallet Toolbox is the reference implementation of the BRC-100 wallet standard. It connects the SDK's cryptographic primitives to real storage backends (SQLite, MySQL, IndexedDB), network services (ARC, WhatsOnChain, Chaintracks), and signing flows to provide a complete, production-ready wallet that developers can use directly or customize for their own wallet apps (like BSV Desktop or BSV Browser).

## Commands

```bash
npm install              # install deps
npm run build            # tsc --build (compiles all 3 tsconfigs: all/client/mobile)
npm test                 # build + jest, excludes *.man.test.ts (manual/network)
npm run test:watch       # build + jest --watch
npm run test:coverage    # build + jest --coverage
npm run lint             # ts-standard --fix on src/**/*.ts
npm run lint:ci          # ts-standard (no fix) — CI gate
npm run doc              # ts2md → docs/*.md from JSDoc
npm run sync-versions    # propagate root version to client/ and mobile/ package.json
```

### Run a single test
Tests live in `src/__tests/` and `test/`. Match patterns include `**/*.test.ts` and `**/__test/**/*.test.ts`. Build runs first (`npm test` does `npm run build && jest`), so to skip rebuild use jest directly after a build:
```bash
npx jest test/Wallet/createAction.test.ts          # one file
npx jest -t "creates action with single output"    # one test name
npx jest --testPathPattern=monitor                  # one folder
```

`*.man.test.ts` files are manual/integration tests requiring network or long runs; they are intentionally excluded from `npm test` and CI.

### Three-bundle build architecture
This single source tree publishes three npm packages from `out/`, `client/out/`, `mobile/out/`. Each has its own tsconfig and its own entry file in `src/`:

| Package | Entry | tsconfig | Includes |
|---------|-------|----------|----------|
| `@bsv/wallet-toolbox` | `src/index.ts` (re-exports `index.all.ts`) | `tsconfig.all.json` | All backends (Knex/SQLite/MySQL + IndexedDB + remote) |
| `@bsv/wallet-toolbox-client` | `src/index.client.ts` | `tsconfig.client.json` | Browser only — no Knex/SQLite/MySQL |
| `@bsv/wallet-toolbox-mobile` | `src/index.mobile.ts` | `tsconfig.mobile.json` | Mobile only — IndexedDB + remote |

When adding a new export, decide which bundles it belongs in and update the matching `index.*.ts`. **Do not add Node-only imports (knex, mysql2, better-sqlite3, fs, express) to code that ends up in client/mobile builds** — `tsc --build` will succeed (skipLibCheck), but the bundled output will fail at runtime in the browser. `client/package.json` and `mobile/package.json` deliberately omit those packages from `dependencies`.

## Public API Surface

### Main Setup Exports
- **`SetupWallet(config?)`** — Factory function returning a fully initialized `Wallet` instance with sensible defaults; config includes `env: 'main' | 'test'`, `endpointUrl`, `chain`
- **`Setup(options)`** — Advanced configuration factory with explicit storage, services, and key manager injection
- **`SetupClient(options)`** — Browser-only setup excluding Node.js storage backends (Knex/SQLite/MySQL)
- **`SetupWallet(config)`** — Convenience wrapper around `Setup`

### Core Wallet Class
- **`Wallet`** — Main BRC-100 wallet implementation; methods:
  - `createAction(args: CreateActionArgs)` — Create transaction from outputs; returns signable transaction reference
  - `signAction(args: SignActionArgs)` — Sign a created action; returns signature(s)
  - `listActions(args: ListActionsArgs)` — Query transaction history
  - `listOutputs(args: ListOutputsArgs)` — Query UTXO state and spent history
  - `internalizeAction(args)` — Import external transaction into wallet tracking
  - `relinquishOutput(args)` — Mark output as no longer spendable (e.g., for dust)
  - `getPublicKey(args)` — Retrieve identity or derivation key
  - `listCertificates()` — List installed certificates for peer auth
  - `proveCertificate(args)` — Generate certificate proof
  - `discoverByTopic(args)` — Resolve identity/protocol from overlay topics
  - `listPermissions(args)` — Query permission grants by app
  - `submitDirectTransaction(tx)` — Bypass action framework for raw tx submission (advanced)

### Storage Layer
From `storage/` — pluggable backends:
- **`KnexWalletStorage`** — SQL backend (SQLite, MySQL, PostgreSQL) via Knex query builder
- **`IndexedDBWalletStorage`** — Browser IndexedDB (client and mobile builds)
- **`RemoteWalletStorage`** — HTTP client for remote server (client/server via HTTPS)
- **`StorageProvider`** — Factory pattern for storage selection
- All implement: `WalletStorage` interface with methods for actions, outputs, certificates, permissions

### Services Layer
From `services/` — network integration:
- **`Services`** — Aggregated network services container; includes:
  - `broadcaster: Broadcaster` — Transaction submission (ARC, WhatsOnChain, etc.)
  - `chainTracker: ChainTracker` — Block header and UTXO queries
  - `merkleVerifier: MerkleVerifier` — SPV proof validation
  - `lookupService: LookupService` — Overlay service resolution
- **`ArcSSEClient`** — Server-sent events for real-time ARC transaction status
- Service providers for mainnet, testnet, local

### Monitor Daemon
From `monitor/` — background transaction tracking:
- **`Monitor`** — Long-running service that:
  - Polls pending transactions for confirmation
  - Detects chain reorganizations
  - Acquires merkle proofs
  - Rebroadcasts stalled transactions
  - Updates wallet state automatically
- Methods: `start()`, `stop()`, `startTasks()`, `stopTasks()`
- Runs independently or integrated into `Wallet`

### Key Management
- **`PrivilegedKeyManager`** — Secure key storage with:
  - Shamir secret sharing for multi-party recovery
  - Obfuscation of root keys in storage
  - Protocol-based key derivation (BRC-42/43)
- **`SimpleWalletManager`** — Lighter-weight key manager for testing/development
- **`ShamirWalletManager`** — Production key manager with advanced secret sharing
- **`CWIStyleWalletManager`** — Key manager for CWI-style wallets

### Permission Management
- **`WalletPermissionsManager`** — Fine-grained per-app, per-protocol permissions:
  - Tracks which apps can do what (e.g., "App A can spend tokens from Protocol X")
  - Supports grouped approval flows (ask once for multiple related operations)
  - Integration hooks for permission modules (e.g., BTMS token module)
- Methods: `requestPermission()`, `grantPermission()`, `revokePermission()`, `listPermissions()`

### Signing Integration
- **`WalletSigner`** — Adapter bridging BRC-100 wallet to SDK's `Transaction.sign()` interface
  - Converts wallet interface to SDK substrate for transparent signing
  - Handles multi-signature orchestration

### Utilities
From `utility/`:
- **`MessageSigner`** — BRC-18 signed message support
- **`OutputTracker`** — UTXO state machine with spent/unspent/locked transitions
- **`CertificateManager`** — X.509-like certificate storage and retrieval
- **`WalletLogger`** — Structured logging for debugging
- **`EntropyCollector`** — Browser mouse/touch entropy for CSPRNG seeding

### MockChain
From `mockchain/` — in-memory blockchain for testing:
- **`MockChain`** — Simulated blockchain with:
  - `mine()` — Create new block with pending transactions
  - `broadcast(tx)` — Submit transaction
  - `getUTXOs(address)` — Query outputs
  - Full merkle proof generation without network
- Used in test suites; allows offline wallet testing

### Specialized Modules
- **`WalletAuthenticationManager`** — User login/2FA
- **`WalletSettingsManager`** — Wallet configuration and preferences
- **`WABClient`** — Web App Bridge client for secure wallet communication
- **`EntropyCollector`** — Gathers entropy in browser for key generation

## Real Usage Patterns

### 1. Create wallet with default SQLite storage (Node.js)
```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'

const wallet = await SetupWallet({
  env: 'main'  // mainnet
})

// Ready to use immediately
const action = await wallet.createAction({
  description: 'Send payment',
  outputs: [{
    satoshis: 5000,
    lockingScript: '76a914...',
    outputDescription: 'payment'
  }]
})
```

### 2. Browser wallet with IndexedDB
```typescript
import { SetupClient } from '@bsv/wallet-toolbox'

const wallet = await SetupClient({
  env: 'test',  // testnet
  storageProvider: 'indexeddb'
})

const utxos = await wallet.listOutputs({
  includeSpent: false,
  basket: 'default'
})
```

### 3. Remote wallet (client/server with HTTPS)
```typescript
const wallet = await SetupClient({
  endpointUrl: 'https://wallet-server.example.com',
  storageProvider: 'remote'
})

// All wallet calls go over HTTPS; keys stay server-side
```

### 4. Full setup with custom key manager and services
```typescript
import { Setup, PrivilegedKeyManager, Services } from '@bsv/wallet-toolbox'

const keyManager = new PrivilegedKeyManager({
  rootKeyHex: '...',  // from secure storage
  passwordHash: '...'
})

const wallet = await Setup({
  keyManager,
  services: await Services.build('main'),
  storage: await KnexWalletStorage.build({
    client: 'sqlite3',
    filename: './wallet.db'
  })
})
```

### 5. Integrate BTMS token permissions
```typescript
import { WalletPermissionsManager } from '@bsv/wallet-toolbox'
import { createBtmsModule } from '@bsv/btms-permission-module'

const permissionsManager = new WalletPermissionsManager(wallet, appOrigin, {
  permissionModules: {
    btms: createBtmsModule({ wallet, promptHandler: myUIPromptFunction })
  }
})

// Now BTMS token operations are gated by permissions
```

### 6. Monitor for transaction confirmations
```typescript
const monitor = new Monitor(wallet.storage, wallet.services, {
  pollIntervalMs: 10000  // Check every 10 seconds
})

await monitor.startTasks()

// Monitor will automatically:
// - Detect confirmations
// - Acquire merkle proofs
// - Rebroadcast failed txs
// - Update wallet state
```

### 7. Sign transaction via wallet
```typescript
import { WalletSigner } from '@bsv/wallet-toolbox'
import { Transaction } from '@bsv/sdk'

const signer = new WalletSigner(wallet)

const tx = new Transaction()
// ... add inputs/outputs ...

await tx.sign([signer])  // Use wallet for signing
const broadcastResp = await tx.broadcast()
```

## Key Concepts

- **BRC-100 Wallet Interface** — Standardized interface that all wallet implementations follow. Enables apps to work with any wallet (BSV Desktop, BSV Browser, custom wallets, hardware wallets) without code changes.
- **Action** — High-level transaction intent created by app. Wallet converts to specific inputs/outputs. Allows for privacy (app doesn't see which UTXOs used) and flexibility (wallet picks best coins).
- **SignableTransaction** — Wallet's opaque reference to a created action. App requests wallet to sign this reference; wallet does the actual ECDSA signing.
- **Certificate** — P2P authentication proof. Identity key + signature over challenge. Used for peer-to-peer overlay protocols.
- **Protocol** — Namespace for overlay services (e.g., "BTMS" tokens, "Document Registry", custom apps). Each protocol has its own permissions, topics, and discovery.
- **Storage Backend** — Pluggable abstraction. Same `Wallet` code works with SQLite (Node.js), IndexedDB (browser), or remote HTTPS server without code changes.
- **Chain Tracker** — Maintains blockchain state (headers, confirmed height). Enables SPV-based transaction verification without full node.
- **Monitor** — Background daemon that polls wallets' own transactions and updates confirmed status without app polling.
- **Key Derivation** — BRC-42/43 protocol-based hierarchical key generation. Each protocol can request keys from a single root without exposing the root.

## Dependencies

### Runtime (from package.json)
- **`@bsv/sdk`** ^2.0.14 — Crypto primitives and transaction library
- **`@bsv/auth-express-middleware`** ^2.0.5 — Auth for Express routes
- **`@bsv/payment-express-middleware`** ^2.0.2 — Payment handling middleware
- **`better-sqlite3`** ^12.6.2 — SQLite engine for Node.js storage
- **`express`** ^4.21.2 — Web framework for server routes (optional for client builds)
- **`hash-wasm`** ^4.12.0 — Cryptographic hashing
- **`idb`** ^8.0.2 — IndexedDB wrapper for browser storage
- **`knex`** ^3.1.0 — SQL query builder for database abstraction
- **`mysql2`** ^3.12.0 — MySQL driver for database storage
- **`ws`** ^8.18.3 — WebSocket for relay and overlay connections

### Peer Deps
- None explicitly, but `express` is runtime-required for server features

### Other ts-stack packages
- **`@bsv/sdk`** — Core crypto and transactions
- (Others in wallet family are peer deps, not runtime deps)

## Conventions

- **Linter**: `ts-standard` (TypeScript Standard). `.eslintrc.json` disables a long list of rules (no-floating-promises, strict-boolean-expressions, naming-convention, etc.) — match existing style rather than introducing strict equivalents.
- **TS strictness**: `strict: true` and `noImplicitOverride: true` across all three tsconfigs; `noImplicitAny: false`. Targets `es2018`, `commonjs`.
- **No new runtime deps without discussion** — CONTRIBUTING.md states the library should stay lean. Prefer adding to `@bsv/sdk` or implementing in-tree.
- **JSDoc is required** on public APIs — `npm run doc` regenerates `docs/*.md` from JSDoc via `ts2md` and is part of `prepublish`. PRs that touch the public surface should rerun `npm run doc`.
- **Version sync**: `syncVersions.js` keeps `client/package.json` and `mobile/package.json` versions aligned with the root. Run `npm run sync-versions` after a version bump, never edit the sub-package versions by hand.

## Common Pitfalls / Gotchas

1. **Storage backend mismatch** — `SetupClient` excludes SQLite/MySQL. Don't try to use Knex in browser builds; it will fail at runtime. Use IndexedDB or RemoteWalletStorage for client/mobile.

2. **Wallet state consistency** — If monitor is not running, wallet won't know about confirmations. Apps must either run monitor or poll `listActions()` manually.

3. **Key manager initialization order** — `PrivilegedKeyManager` must be initialized before `Setup`. Initializing after will cause signing to fail silently.

4. **Permission denial vs. network error** — When an app is denied permission, the wallet may reject the action. Apps should distinguish between permission denials and actual errors.

5. **Monitor task conflicts** — Don't run multiple monitor instances on the same storage simultaneously; they will race and cause state corruption. Use a single monitor per wallet.

6. **CORS on RemoteWalletStorage** — If using HTTP remote storage from browser, the server must have CORS headers set correctly. `withCredentials: true` is used; server must respond with `Access-Control-Allow-Credentials: true`.

7. **Action reference lifetime** — `SignableTransaction.reference` is valid only for a short window. Don't cache references; create a new action and sign immediately.

8. **Fee estimation timing** — Action creation doesn't include fees by default. Call `wallet.estimateFee()` separately or let the wallet estimate during signing.

9. **Output reuse in multi-sig** — If same output is used in multiple pending actions, only one will succeed. Wallet should prevent this, but apps shouldn't rely on it.

10. **Certificate expiry** — Certificates have expiration. Check `cert.expires` before using for peer authentication. Expired certs are silently rejected.

11. **Entropy in browser** — `EntropyCollector` requires user interaction (mouse/touch) to work. In headless tests, provide seed entropy manually.

12. **IDB quota limits** — Browser IndexedDB has quotas (typically GB range). Large wallets with many transactions may hit limits. Implement archiving or use RemoteWalletStorage for scale.

## Spec Conformance

- **BRC-100** — Wallet interface standard (full implementation)
- **BRC-18** — Signed messages support
- **BRC-42, BRC-43** — Key derivation protocols
- **BRC-62** — BEEF transaction envelope support
- **SPV** — Full merkle proof verification
- **Bitcoin Script** — Full script evaluation

## File Map

- **`src/Wallet.ts`** — Main BRC-100 wallet class
- **`src/Setup.ts`**, **`src/SetupWallet.ts`**, **`src/SetupClient.ts`** — Initialization factories
- **`src/storage/`** — Storage backends (KnexWalletStorage, IndexedDBWalletStorage, RemoteWalletStorage)
- **`src/services/`** — Network services (ARC, WhatsOnChain, Chaintracks integration)
- **`src/monitor/`** — Transaction monitoring daemon
- **`src/sdk/`** — Key managers (PrivilegedKeyManager, SimpleWalletManager, etc.)
- **`src/signer/`** — WalletSigner adapter
- **`src/utility/`** — Helpers (logging, entropy, output tracking)
- **`src/mockchain/`** — In-memory blockchain for testing
- **`src/WalletPermissionsManager.ts`** — Permission system
- **`src/WalletLogger.ts`** — Structured logging
- **`src/entropy/EntropyCollector.ts`** — Browser entropy collection

## Integration Points

- **@bsv/sdk** — Uses SDK Transaction, PrivateKey, Script, all crypto
- **@bsv/btms-permission-module** — BTMS tokens register as permission module; wallet-toolbox hosts the permission manager
- **@bsv/wallet-relay** — Mobile wallet pairing uses wallet-toolbox as the wallet backend
- **Express middleware** — auth-express-middleware and payment-express-middleware authenticate and validate requests
- **Database drivers** — Knex abstracts SQLite (better-sqlite3) and MySQL (mysql2)
- **ARC/WhatsOnChain/Chaintracks** — Network service integrations via HTTP
- **Browser APIs** — IndexedDBWalletStorage uses IndexedDB API; EntropyCollector uses mouse/touch events
