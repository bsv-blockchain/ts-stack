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

| Method                             | BRC-207 query                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `spendability(assetId, outpoints)` | `color-spendability`: outputs currently admitted and unspent                   |
| `admission(assetId, outpoints)`    | `color-admission`: outputs ever admitted, used to read the asset's deploy      |
| `submit(topics, beef)`             | Submits to each topic: `tm_color_<assetId>` per asset, `tm_color` for a deploy |

`requestTokenAccess` receives a JSON message whose `type` is `color_send`,
`color_split`, `color_signature`, `color_access` (a read) or `color_relinquish`,
and returns true to approve. The module asks on every operation and keeps no
grants; the host decides whether an existing grant covers a request and when to
prompt the user.

Call `color.dispose()` when the host tears down the wallet.

## Application calls

- **Send**: `createAction` with the recipient's BRC-162 output and a plan in
  `p color plan` labels, built with `ColorPlan.toLabels`. The module selects
  admitted token inputs and adds token change in `createAction`. In
  `signAction` it checks the funded transaction against the plan, asks the user
  to approve it (`color_send`: every asset leg, satoshi totals and fee, the
  signatures it releases), signs the token inputs with any `sighashTypes`
  override and submits the processed transaction to each asset topic.
- **Mint, burn and authority operations**: the plan declares exactly the
  operations BRC-207 derives from the transaction (`mint`, `burn`,
  `authority-split`, `-combine`, `-transfer`, `-end`). Authority inputs are
  selected from the authority basket when the caller supplies none; mints and
  burns use only the caller's value inputs and get no change.
- **Deploy**: a BRC-162 deploy at output 0 with `options.randomizeOutputs:
false`, `ISSUE` in `plan.assets` and its remittance in `plan.ownedOutputs`.
  The processed deploy is submitted to `tm_color`, and the call fails while
  `tm_color_<assetId>` has not admitted it.
- **Handoff**: the same call with a BRC-177 `p nosend expiry` label and
  `noSend`. When the inputs exceed the amount, the module first broadcasts a
  split to the exact amount, after a separate prompt that shows its fee.
- **Receive**: `internalizeAction` with `basket insertion` into the asset's
  value or authority basket and the BRC-207 receipt instructions. The sender
  must already have submitted the transaction; the received output must be
  admitted and unspent. Every input must unlock its source, every consumed
  token input must have been admitted, and each asset must follow BRC-162's
  supply rules.
- **App-built transactions**: `createSignature` with a `p color` protocol ID
  and a BRC-207 signature envelope in `data`.
- **Reads**: `listOutputs` with `p color assets`, `p color balance <assetTag>`
  or `p color balance <assetTag> authority`. Balances are exact decimal strings.

## Limits of this version

The module fails explicitly, rather than falling back, on:

- BRC-161 JSON outputs (assets first deployed as BRC-161, at any output index, are
  supported in BRC-162 form);
- assets whose deploy declares required processing profiles;
- `tokenProofs` and `profileData` entries;
- explicit inputs together with a BRC-177 handoff.

Explicit inputs are supported: this wallet's `p color` outputs are signed by the
module, and foreign token inputs count only once their asset's overlay admits
them. An input missing from `inputBEEF` is resolved by the wallet and checked
in `signAction`. `inputPositions` and `changePositions` are honored; change
positions follow the requested outputs, satoshi change comes after the token
change, and both need `options.randomizeOutputs: false`.

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
