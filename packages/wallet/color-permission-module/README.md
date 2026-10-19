# Color Permission Module

`@bsv/color-permission-module` implements the BRC-207 `color` wallet module for
BRC-162 fungible tokens. It runs inside a `WalletPermissionsManager` and handles
every `p color` protocol, basket and action label.

## Installation

The module needs the wallet that the permissions manager wraps, an overlay
provider and a prompt callback:

```ts
import { createColorModule } from '@bsv/color-permission-module'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

const color = createColorModule({
  wallet: setup.wallet,
  provider: colorOverlayProvider,
  requestTokenAccess: async (originator, message) =>
    await showTokenPrompt(originator, JSON.parse(message))
})

const wallet = new WalletPermissionsManager(setup.wallet, adminOriginator, {
  permissionModules: { color }
})
```

`wallet` must be the underlying wallet, not the permissions manager. The module
derives `p color` keys, signs token inputs and reads its baskets through it.
Inventory listing uses the wallet-toolbox `specOpBasketPrefixOutputs` storage
operation.

`provider` implements `ColorOverlayProvider`. The wallet implementer decides
which overlays it trusts:

| Method                             | BRC-207 query                                                             |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `spendability(assetId, outpoints)` | `color-spendability`: outputs currently admitted and unspent              |
| `admission(assetId, outpoints)`    | `color-admission`: outputs ever admitted, used to read the asset's deploy |
| `submit(assetIds, beef)`           | Submits to `tm_color_<assetId>` for each asset                            |

`requestTokenAccess` receives a JSON message whose `type` is `color_send`,
`color_split`, `color_signature` or `color_access`, and returns true to approve.

Call `color.dispose()` when the host tears down the wallet.

## Application calls

- **Send**: `createAction` with the recipient's BRC-162 output and a plan in
  `p color plan` labels, built with `ColorPlan.toLabels`. The module selects
  admitted token inputs, adds token change, prompts, signs the token inputs in
  `signAction` and submits the processed transaction to each asset topic.
- **Handoff**: the same call with a BRC-177 `p nosend expiry` label and
  `noSend`. When the inputs exceed the amount, the module first broadcasts a
  split to the exact amount, after a separate prompt that shows its fee.
- **Receive**: `internalizeAction` with `basket insertion` into the asset's
  value or authority basket and the BRC-207 receipt instructions. The sender
  must already have submitted the transaction; the received output must be
  admitted and unspent.
- **App-built transactions**: `createSignature` with a `p color` protocol ID
  and a BRC-207 signature envelope in `data`.
- **Reads**: `listOutputs` with `p color assets`, `p color balance <assetTag>`
  or `p color balance <assetTag> authority`. Balances are exact decimal strings.

## Limits of this version

The module fails explicitly, rather than falling back, on:

- issuance, minting, burns and authority operations;
- BRC-161 JSON outputs and assets with legacy nonzero-index IDs;
- assets whose deploy declares required processing profiles;
- `tokenProofs`, `profileData` entries, plan position constraints and
  signature-type overrides;
- explicit inputs in a `createAction` with a plan.

Signatures released through `createSignature` are not yet recorded as BRC-207
exposure.

## Verification

```bash
pnpm --filter @bsv/sdk build
pnpm --filter @bsv/wallet-toolbox-client build
pnpm --filter @bsv/color-permission-module typecheck
pnpm --filter @bsv/color-permission-module lint
pnpm --filter @bsv/color-permission-module test:coverage
```

## License

Open BSV License version 6. See `LICENSE.txt`.
