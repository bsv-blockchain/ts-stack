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
| `submit(topics, beef, offChain?)`  | Submits to each topic: `tm_color_<assetId>` per asset, `tm_color` for a deploy |

`submit` receives a third argument, the raw BRC-22 `offChainValues` bytes, only
for assets whose required profiles supply submission data; every other call
passes two arguments, so a 0.1.0 provider keeps working unchanged. A submit
returns each topic's admittance.

`requestTokenAccess` receives a JSON message whose `type` is `color_send`,
`color_signature`, `color_access` (a read) or `color_relinquish`, and returns
true to approve. Every message
carries `seekPermission` (false only when the caller passed
`seekPermission: false`), and a `color_send` for a plain-noSend hand-over
carries `handoff: true`. A declined request throws `ColorConsentDeclinedError`.
A `color_access` names the `basket` read (with `assetId` and `role` for a
balance or holdings basket) or the `p color` `labels` of a `listActions`. The
module asks
on every operation and keeps no grants; the host decides whether an existing
grant covers a request and when to prompt the user.

Call `color.dispose()` when the host tears down the wallet. Registered on a
`WalletPermissionsManager`, the module advertises `brc207-color=4` (BRC-205) in
the manager's `getVersion` string.

## Application calls

- **Send**: `createAction` with the recipient's BRC-162 output, a plan in
  `p color plan` labels, built with `ColorPlan.toLabels`, and
  `options.randomizeOutputs: false` (every plan requires it: the plan's output
  indices and the approved facts name the requested outputs). The module selects
  admitted token inputs and adds token change in `createAction`, and supplies
  the source transactions of the inputs it selects in `inputBEEF`, merged with
  any `inputBEEF` the caller gave. Every output the module files (token
  change, owned outputs, receipts, deploys and handoff splits) carries the tag
  `p color <hex>`: the lowercase hex of the SHA-256 of the UTF-8 bytes of its
  custody's derivation suffix. The tag is 72 characters
  whatever the suffix, and storage keeps nothing of the suffix itself. The module reads the
  transactions of the inputs it selects by their tags (`tagQueryMode: 'any'`),
  normally with one `listOutputs` per asset basket and `limit` the number of
  selected inputs, capped at 10,000 per page. Different payments may share a
  suffix. When more matching rows exist, the module pages within the initial
  nonnegative safe-integer `totalOutputs` count and stops once every selected source
  is found; a changed count, duplicate row,
  oversized page, stalled traversal or missing selected output fails the call.
  Only selected transactions and their proofs or unproven ancestors are retained;
  other same-tag outputs are neither spent nor credited. An output without its suffix tag is not selected, and an app-named
  input without it is refused, so outputs filed without the tag are not spent
  through the module. Suffix tags are
  left out of the `p color assets` view and of the balance views' tag filters. A selected output whose transaction
  the wallet does not return in full fails the call, naming the outpoint. The
  module stages its record of each input it signs for (outpoint, script,
  satoshis, asset and decrypted custody) when `createAction` funds the action,
  and when the wallet's `createAction` comes back it binds the records of the
  inputs of the returned unsigned transaction to that action's reference.
  `signAction` signs only the inputs bound to its reference, without listing
  the wallet's outputs; a wallet may hide an action's reserved inputs from its
  listings (wallet-toolbox's `auto` action-batch mode does). Which outputs are
  available is storage's to decide; the module also skips outputs staged or
  being selected by its own calls. A reference's records are dropped when
  `signAction` signs or refuses, and on `dispose()`. Two cases leave records
  until `dispose()`: an action aborted before `signAction` leaves its bound
  records unused, and a wallet `createAction` that fails after the module
  funded it leaves its inputs staged, so the module does not select them again
  until `dispose()`. In
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
  `noSend`. For assets without a `plain-nosend` profile this is the only
  `noSend` token action, since a plain `noSend` sent later with `sendWith`
  would never reach the token overlay (see [Required profiles](#required-profiles)
  for plain-noSend hand-overs). When the inputs exceed the amount, the module
  first broadcasts a split to the exact amount. The split pays the wallet
  itself and, like BRC-177's revocation anchor, gets no separate consent.
- **Receive**: `internalizeAction` with `basket insertion` into the asset's
  value or authority basket and the BRC-207 receipt instructions. For assets
  without required profiles, the caller must already have submitted the
  transaction; the received output must be admitted and unspent, and every
  input must unlock its source. The module relies on that admission for the
  transaction's token amounts rather than re-evaluating them. A receipt carries
  BRC-207 custody instructions only (`version`, `assetId`, `derivationPrefix`,
  `derivationSuffix`, `senderIdentityKey`, at most 1000 bytes). For an asset
  whose required profile defines `admitReceipt`, that hook decides admission
  instead (see [Required profiles](#required-profiles)).
- **App-built transactions**: `createSignature` with a `p color` protocol ID
  and a BRC-207 signature envelope in `data`. The whole transaction is
  evaluated as a send is: every input needs its source, every token input must
  be admitted and unspent in its overlay, every source and output of a profile
  asset must conform to its deploy (`req` and each profile's own `ext`), and the
  user approves the same facts
  (`color_signature`: every asset leg, destinations, satoshi totals and fee,
  the signature released) before the module signs.
- **Reads**: `listOutputs` with `p color assets`, `p color balance <assetTag>`
  or `p color balance <assetTag> authority`. Balances are exact decimal strings.
  As in BTMS, reads report wallet state alone and never query the overlay: the
  inventory tags each output `color_state_available` or `color_state_reserved`
  (an input of a pending action). Overlay spendability is checked only when
  spending.

## Required profiles

A deploy may require BRC-207 processing profiles in its `req` map. Without
registered handlers the module refuses every such asset, exactly as 0.1.0 did,
and never touches a store. A host that supports profiles registers one handler
per profile id and injects a durable store:

```ts
import { createColorModule } from '@bsv/color-permission-module'

const color = createColorModule({
  wallet: underlyingWallet,
  provider: defaultProvider,
  requestTokenAccess,
  store, // ColorModuleStore: durable get/set/delete/keys
  profiles: {
    [issuerProfile.id]: issuerProfile // every profile the host's assets require
  }
})
```

Each `profiles` key must equal its handler's `id`, and `store` is required when
`profiles` is non-empty; the constructor throws a `TypeError` otherwise. Every
store key the module writes starts with `color.v1.`: the deploy cache and the
settled records `markSettled` writes. The layout under that prefix is internal
to the module, and hosts never read or write it.

The registry fails closed: an asset is supported only when every profile in its
deploy's `req` is registered with a matching version (`versions`), otherwise
`UnsupportedProfileError`, checked for every entry before any handler code runs.
Handlers only restrict what the module would otherwise do. The deploy is
resolved, each source checked against its transaction id, from the `color.v1.`
cache, then the default provider, then each handler's `deployProviders()` in
registration order. A `RequiredProfileHandler` (`ProfileDescriptor`,
`ProfileAssetContext`, `ProfileTxView`, `ProfileReceipt` and `ReceiptAdmission`
are exported types) defines:

| Member            | When it runs and what it decides                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `versions`  | The profile URI and the exact versions it supports                                                                                                                                                                                                                                                                                   |
| `checkDescriptor` | Synchronously, at asset resolution: validates its `req` entry against the whole `req`; throws `ProfileParamsError`                                                                                                                                                                                                                   |
| `checkExt`        | At asset resolution and for every token of the asset: validates the profile's own `ext` entry; without it that entry must be absent                                                                                                                                                                                                  |
| `provider`        | Routes every spendability, admission and submit call for the asset; two handlers of one asset returning different providers fail with `ProfileParamsError`                                                                                                                                                                           |
| `deployProviders` | Asked in order for an unknown asset's deploy after the default provider                                                                                                                                                                                                                                                              |
| `sendPolicy`      | `'plain-nosend'`: every token `createAction` moving the asset must be `noSend` without a BRC-177 expiry label; token change stays in the transaction, tagged `color_offline`, and the module never submits the action. `signAction` refuses `options.noSend: false` or a `sendWith` batch and returns `noSend: true`, `sendWith: []` |
| `operations`      | The operations a holder may declare for the asset; absent means all                                                                                                                                                                                                                                                                  |
| `checkPlanData`   | In `createAction` and again in `signAction`: checks the plan's `profileData` leaf for the asset (undefined when absent); throws `ProfileDataError`. A profile without it accepts no plan leaf                                                                                                                                        |
| `submissionData`  | In `signAction` of an action the module submits, before signing: the non-empty `offChainValues` bytes submitted to `tm_color_<assetId>`; at most one handler per asset. Not called for a plain-noSend hand-over                                                                                                                      |
| `admitReceipt`    | For every receipt of the asset, after the custody, basket, ownership and deploy-conformance checks, in place of the overlay spendability check: `{ credit: 'settled' }` credits it, `{ credit: 'pending' }` credits it tagged `color_offline`, a throw credits nothing; at most one handler per asset                                |

Plan `profileData` may name only profiles in the asset's `req` and assets in
`plan.assets` (`ProfileDataError` otherwise). A receipt never carries
`profileData`: any non-empty receipt `profileData` fails with the 0.1.0 error,
and the wallet always receives the 5-member custody JSON.

Every token of a profile asset the module reads, as a source or an output, in
`createAction` (requested outputs and explicit inputs), `signAction` (the final
transaction), `createSignature` and receipts, must conform to the deploy: a
repeated `req` must be byte-identical to the deploy's, and each required
profile's `checkExt` must accept its own `ext` entry. A BRC-161 JSON leg
supplies no `ext` state, so `checkExt` sees an absent entry and may reject it.

### Receipts admitted by a profile

`admitReceipt(ctx, receipt)` receives the asset's `ProfileAssetContext` (the
underlying wallet, this wallet's identity key, the authenticated deploy and the
profile's descriptor) and `{ assetId, txid, outputIndex, tx, beef }`, where `tx`
is the received `Transaction` and `beef` the caller's `internalizeAction` bytes.
It runs once per receipt output, in order, independent of any other profile.
The module never parses, stores or submits evidence for it: a token issuer's
own library, running in the host, verifies whatever the parties exchanged and
records its decision where an app cannot write, and the hook reads that record
or asks the issuer's overlay itself.

### Pending outputs and `markSettled`

A receipt admitted as `pending`, and the token change of a plain-noSend
hand-over, carry the stored tag `color_offline`. Views (`p color assets`,
balances and tag filters) show it, so `p color balance <assetTag>` with
`tags: ['color_offline']` is the pending balance. A `color_offline` output is
spendable only once its overlay lists it: the module never resubmits it, and
never resubmits any output of an asset whose profiles declare a `sendPolicy` or
`submissionData`, since the wallet's copy carries no off-chain values.

The host submits plain-noSend hand-overs and pending receipts, then calls
`color.markSettled(txid)` once the overlay admitted the transaction.
`markSettled` is an in-process method of the module object, not a BRC-100 call,
so no app can reach it. It writes `color.v1.settled.<txid>` once (a second call
writes nothing), and views then hide `color_offline` for that transaction's
outputs. A lost store shows them as pending again. Without profiles it does
nothing; a txid that is not lowercase hex throws a `TypeError`.
Caller-supplied `color_*` tags are stripped whenever profiles are registered.

### Errors

`ProfileParamsError`, `ProfileDataError` and `ColorConsentDeclinedError` are
exported runtime values. Each sets `name` to its class name and starts its
message with `[ClassName] `. Hosts and bridges match on `name`, then on that
prefix, never on `instanceof`, since the module can be loaded more than once.
`UnsupportedProfileError` keeps its 0.1.0 messages.

## Limits of this version

The module fails explicitly, rather than falling back, on:

- holding, creating or filing BRC-161 JSON outputs, and the BRC-161 `burn`
  operation. BRC-161 JSON `transfer`, `mint` and `deploy+mint` outputs are read
  as value and `auth` and `deploy+auth` as authority, as inputs and as outputs
  to other parties, with the same overlay checks as any foreign token input; the
  envelope may sit anywhere in the script (BRC-160). Only value inputs can fund
  JSON transfer outputs; a JSON mint needs an authority input. Assets first
  deployed as BRC-161, at any output index, are supported in BRC-162 form;
- assets whose deploy declares required processing profiles that no
  registered handler supports, among them BRC-209;
- `profileData` in receipts, and plan `profileData` for profiles the asset does
  not require;
- receipt `customInstructions` above 1000 bytes;
- building a deploy that declares a non-empty `req`, and `ISSUE` leaves in plan
  `profileData`: such deploys are built outside the module;
- `createSignature` for assets whose profiles define `sendPolicy`,
  `submissionData` or `checkPlanData`, since a released signature cannot carry
  submission data, stay off the wire or pass through a plan whose transition a
  profile checks;
- satoshi change positions (`changePositions` with a null `assetId`): wallet-toolbox
  adds satoshi change while funding and does not position it.

A plain-noSend hand-over still needs its asset overlay reachable at
`createAction` and `signAction`: every input, including a `color_offline` one,
must be listed as admitted and unspent. The module carries no token history and
validates none; a profile whose tokens move through chains of unsettled
hand-overs relies on its own library for that.

Explicit inputs are supported: this wallet's `p color` outputs are signed by the
module, and foreign token inputs count only once their asset's overlay admits
them. The module supplies `inputBEEF` for the inputs it selects; the source
transactions of an input the app names are the app's to supply in `inputBEEF`,
as wallet-toolbox requires for explicit inputs. `inputPositions` and token `changePositions` are honored; change
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
and `transactionConsent`. Their 0.1.0 positional calls are unchanged; the hand-over flag and
the token reader go in a trailing options object (`ActionConsentOptions`, or
`TransactionConsentOptions` in place of the `deployOwned` boolean).

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
