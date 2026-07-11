# Managed change, sweeping, and recovery

The default basket is the wallet's funding pool. An output being physically
stored in that basket is not, by itself, proof that the wallet can spend it.
Automatic funding and wallet balance therefore use the managed-change policy
below instead of trusting basket membership or the locking script alone.

## Output classes

A **managed change output** has all of the following metadata:

- `type: 'P2PKH'`
- `change: true`
- `providedBy: 'storage'`
- `purpose: 'change'`
- non-empty `derivationPrefix` and `derivationSuffix`

Here, `type: 'P2PKH'` is an operational signer type, not merely a description
of the script. It selects the BRC-29 unlocking path. A raw P2PKH output without
matching derivation metadata is not managed change and must not be selected by
the wallet automatically.

A **custom output** belongs to an application-defined protocol. It is normally
stored outside the default basket with `type: 'custom'`, `change: false`, and
`providedBy: 'you'`. Custom outputs are discoverable and may be explicitly
spent by application logic, but are not wallet balance and are never automatic
fee inputs.

## Enforcement

The same managed-change predicate is applied to:

- change-input counting and allocation in Knex/SQLite/MySQL and IndexedDB;
- the default wallet balance and `balanceAndUtxos()` results; and
- validation of `noSendChange` inputs.

Raw administrative `listOutputs({ basket: 'default' })` remains unfiltered on
purpose. This makes incompatible legacy rows visible for diagnosis and recovery
without allowing them into balance or automatic funding.

## `internalizeAction` rules

| Request | New output | Existing custom output | Existing managed change |
| --- | --- | --- | --- |
| `wallet payment` | Store as managed change in `default` | Promote to managed change after BRC-29 script verification | Idempotent when already in `default` |
| `basket insertion` to a non-default basket | Store as custom | Move/update as custom; no wallet-balance adjustment | Reject; managed change cannot be reclassified |
| `basket insertion` to `default` | Reject | Reject | Reject |

The wallet signer verifies that `paymentRemittance` derives the transaction
output's locking script before storage can promote it. This is the supported
way to repair a genuine BRC-29 payment that was previously classified as
custom. Merely recognizing a P2PKH locking script is not enough.

## Sweeping and recovery

"Sweep" means moving an incompatible custom row out of the default basket with
a `basket insertion` into a named, non-default recovery basket. This is a
metadata repair: the output remains custom and wallet balance does not change.

There are two valid recovery choices for a legacy custom row in `default`:

1. If it is a genuine payment to this wallet under BRC-29, internalize it as a
   `wallet payment` with the correct derivation prefix, derivation suffix, and
   sender identity key. Successful verification promotes it to managed change
   and adds its value to wallet balance.
2. Otherwise, sweep it to a non-default basket. The application can then apply
   its own unlocking and lifecycle rules explicitly.

Do not repair rows by directly changing `type`, `change`, or derivation fields.
That bypasses the BRC-29 ownership check and can make balance appear spendable
when the wallet does not possess the required key path.

## BRC-29 remittance module

`Brc29RemittanceModule` always accepts settlements through the `wallet payment`
protocol. The deprecated `internalizeProtocol: 'basket insertion'` setting is
rejected because it supplied no insertion remittance and would classify a
recipient payment as a custom application output instead of spendable wallet
balance.
