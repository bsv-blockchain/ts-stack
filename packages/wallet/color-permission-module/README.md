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
`color_signature`, `color_access` (a read) or `color_relinquish`,
and returns true to approve. A `color_access` names the `basket` read (with
`assetId` and `role` for a balance or holdings basket) or the `p color`
`labels` of a `listActions`, and the caller's `seekPermission`. The module asks
on every operation and keeps no grants; the host decides whether an existing
grant covers a request and when to prompt the user.

Call `color.dispose()` when the host tears down the wallet. Registered on a
`WalletPermissionsManager`, the module advertises `brc207-color=5` (BRC-205) in
the manager's `getVersion` string.

## Application calls

- **Send**: `createAction` with the recipient's BRC-162 output, a plan in
  `p color plan` labels, built with `ColorPlan.toLabels`, and
  `options.randomizeOutputs: false` (every plan requires it: the plan's output
  indices and the approved facts name the requested outputs). The module selects
  admitted token inputs and adds token change in `createAction`. In
  `signAction` it checks the funded transaction against the plan, asks the user
  to approve it (`color_send`: every asset leg, satoshi totals and fee, the
  signatures it releases), signs the token inputs with any `sighashTypes`
  override and submits the processed transaction to each asset topic, trying up
  to three times. As in BTMS, an accepted submission completes the action, and
  a held output the overlay does not report is resubmitted from the wallet's
  copy of its transaction when it is next selected.
- **Mint, burn and authority operations**: the plan declares exactly the
  operations BRC-207 derives from the transaction (`mint`, `burn`,
  `authority-split`, `-combine`, `-transfer`, `-end`). Authority inputs are
  selected from the authority basket when the caller supplies none; mints and
  burns use only the caller's value inputs and get no change.
- **Deploy**: a BRC-162 deploy at output 0 with `ISSUE` in `plan.assets` and
  its remittance in `plan.ownedOutputs`.
  Once signed, an owned deploy is filed in its asset's value or authority
  basket (keeping its `ISSUE` key) through the wallet's `internalizeAction`,
  then submitted to `tm_color`; `tm_color_<assetId>` must admit it before it
  can be spent. A deploy cannot be a `noSend` action.
- **Handoff**: the same call with a BRC-177 `p nosend expiry` label and
  `noSend`; this is the only `noSend` token action, since a plain `noSend`
  sent later with `sendWith` would never reach the token overlay. When the
  inputs exceed the amount, the module first broadcasts a
  split to the exact amount. The split pays the wallet itself and, like
  BRC-177's revocation anchor, gets no separate consent.
- **Receive**: `internalizeAction` with `basket insertion` into the asset's
  value or authority basket and the BRC-207 receipt instructions. The caller
  must already have submitted the transaction; the received output must be
  admitted and unspent, and every input must unlock its source. The module
  relies on that admission for the transaction's token amounts rather than
  re-evaluating them.
- **App-built transactions**: `createSignature` with a `p color` protocol ID
  and a BRC-207 signature envelope in `data`. The whole transaction is
  evaluated as a send is: every input needs its source, every token input must
  be admitted and unspent in its overlay, and the user approves the same facts
  (`color_signature`: every asset leg, destinations, satoshi totals and fee,
  the signature released) before the module signs.
- **Reads**: `listOutputs` with `p color assets`, `p color balance <assetTag>`
  or `p color balance <assetTag> authority`. Balances are exact decimal strings.
  As in BTMS, reads report wallet state alone and never query the overlay: the
  inventory tags each output `color_state_available` or `color_state_reserved`
  (an input of a pending action). Overlay spendability is checked only when
  spending.

## Limits of this version

The module fails explicitly, rather than falling back, on:

- holding, creating or filing BRC-161 JSON outputs, and the BRC-161 `burn`
  operation. BRC-161 JSON `transfer`, `mint` and `deploy+mint` outputs are read
  as value and `auth` and `deploy+auth` as authority, as inputs and as outputs
  to other parties, with the same overlay checks as any foreign token input; the
  envelope may sit anywhere in the script (BRC-160). Only value inputs can fund
  JSON transfer outputs; a JSON mint needs an authority input. Assets first
  deployed as BRC-161, at any output index, are supported in BRC-162 form;
- assets whose deploy declares required processing profiles;
- `profileData` entries;
- satoshi change positions (`changePositions` with a null `assetId`): wallet-toolbox
  adds satoshi change while funding and does not position it.

Explicit inputs are supported: this wallet's `p color` outputs are signed by the
module, and foreign token inputs count only once their asset's overlay admits
them. An input missing from `inputBEEF` is resolved by the wallet and checked
in `signAction`. `inputPositions` and token `changePositions` are honored; change
positions follow the requested outputs.

The module does not validate BRC-176 lineage: proof transport is not part of
BRC-207, and a separate module will feed lineage packets to a wallet-local
overlay before this one runs. It relies on overlay admission and spendability.
Plans, signature envelopes and receipt instructions have no `tokenProofs`
member, and a `p color` label other than a plan label is rejected.

Signatures released through `createSignature` are not yet recorded as BRC-207
exposure. BRC-207's non-final transaction rules are not implemented; such
transactions follow the wallet's existing behavior.

## Extending the module

A wallet with its own token policy can subclass `ColorPermissionModule`: its
members are `protected`, so a derivative can override, for example, `approve`
(the consent prompt), `assertSupportedAsset` (which assets it handles),
`selectInputs` (coin selection) or `spendable` (the overlay query). The helpers
the module evaluates transactions with are exported too: the token readers
(`readTokenOutput`, `tryReadTokenOutput`, `readSentToken`), `transactionTokens`,
`requiredOperations`, `supplyChange`, and the consent builders `actionConsent`
and `transactionConsent`.

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
