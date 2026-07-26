# @bsv/btms-permission-module

Framework-agnostic wallet permission checks for BTMS token access, transfers,
and burns.

The module implements the wallet-toolbox `PermissionsModule` hooks used by
BRC-100 wallets. A host wallet supplies the trusted prompt UI; this package has
no browser, React, or other UI dependency.

## Installation

```bash
npm install @bsv/btms-permission-module @bsv/btms @bsv/sdk @bsv/wallet-toolbox-client
```

Node.js 22 or newer is required. The package provides a typed ESM entry point.

## Quick Start

Use the factory when the module should enrich prompts with BTMS metadata:

```typescript
import { createBtmsModule } from '@bsv/btms-permission-module'

const btmsPermissions = createBtmsModule({
  wallet,
  promptHandler: async (originator, message) => {
    const request = message.startsWith('{') ? JSON.parse(message) : { message }
    return showTrustedWalletPrompt({ originator, request })
  }
})
```

If `promptHandler` is omitted, the factory denies requests by default.

Alternatively, construct the module directly. Metadata enrichment is optional:

```typescript
import { BasicTokenModule } from '@bsv/btms-permission-module'

const btmsPermissions = new BasicTokenModule(async (originator, message) => {
  return showTrustedWalletPrompt({ originator, message })
})
```

Register the result under the `btms` permission scheme in the host wallet's
`WalletPermissionsManager` configuration:

```typescript
const permissionsManager = new WalletPermissionsManager(wallet, adminOriginator, {
  ...permissionConfig,
  permissionModules: {
    ...permissionConfig.permissionModules,
    btms: btmsPermissions
  }
})
```

Call `btmsPermissions.dispose()` when the wallet tears down the module. This
immediately clears its in-memory sessions and transaction commitments.

## Prompt Contract

The callback receives the requesting originator and either a JSON message or a
conservative generic message. The JSON variants are:

```typescript
type BTMSSpendPrompt = {
  type: 'btms_spend'
  sendAmount: number
  tokenName: string
  assetId: string
  recipient?: string
  iconURL?: string
  changeAmount: number
  totalInputAmount: number
}

type BTMSBurnPrompt = {
  type: 'btms_burn'
  burnAmount: number
  tokenName: string
  assetId: string
  iconURL?: string
  burnAll: boolean
}

type BTMSAccessPrompt = {
  type: 'btms_access'
  action: 'access BTMS tokens'
  assetId?: string
}
```

The host must display prompts in trusted wallet chrome, identify the originator,
escape untrusted text, and return `true` only after an explicit user decision.

## Security Model

The module:

- prompts before token access, transfer, or burn operations;
- isolates authorization by originator and expires it after 60 seconds;
- binds a successful `createAction` response to the exact SHA-256 signing
  digest for every input in the returned transaction;
- rejects signature requests that change any signed transaction field;
- invalidates authorization if the returned transaction cannot be parsed and
  bound;
- treats malformed or unbound signature payloads conservatively;
- auto-approves issuance only when an output has the exact
  `btms_type_issue` tag or its PushDrop asset field is exactly `ISSUE`; and
- performs expiry cleanup during requests, without a background timer.

A prompt approval is not a general-purpose wallet grant. Hosts should preserve
the permission module in the signing path for every `p btms ...` basket and
should not reuse its callback as an authorization signal elsewhere.

## Verification

```bash
pnpm --filter @bsv/btms build
pnpm --filter @bsv/btms-permission-module typecheck
pnpm --filter @bsv/btms-permission-module lint
pnpm --filter @bsv/btms-permission-module test:coverage
pnpm --filter @bsv/btms-permission-module build
pnpm --filter @bsv/btms-permission-module pack:check
```

The package enforces coverage thresholds and verifies the packed ESM artifact,
exports, dependency installation, and strict type resolution.

## Related Documentation

- [Integration and lifecycle guide](./INTEGRATION.md)
- [BTMS library](../btms/README.md)
- [BTMS overlay backend](../../overlays/btms-backend/README.md)
- [ts-stack repository overview](../../../README.md)

## License

Open BSV License version 6. See [LICENSE.txt](./LICENSE.txt).
