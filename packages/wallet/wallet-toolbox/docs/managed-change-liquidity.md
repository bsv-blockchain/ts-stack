# Managed-change liquidity policy

Wallet-managed change is both the wallet's balance and its concurrency pool.
An output that is technically spendable but too small to carry a useful action
at the current fee rate does not provide useful liquidity. Conversely, creating
the entire pool in one transaction makes every child carry a large common BEEF
ancestor and creates unnecessary linkage.

This policy keeps `createAction` available to existing callers while gradually
moving new and existing wallets toward useful, parallel funding units.

## Invariants

The implementation treats these as non-negotiable:

1. A policy preference cannot make an action fail if the former planner could
   fund it. Each parent-status tier retries the compatibility funding shape
   before the planner widens to less-preferred ancestry.
2. `completed` parents are preferred, then `unproven`, then `sending`.
   Pending outputs are never withheld: they remain a last-resort source and
   are selected when settled liquidity cannot fund the action.
3. A large settled-input plan may be compared with pending alternatives, but
   only after the configurable comparison threshold. The comparison uses the
   actual serialized BEEF bytes plus the planned transaction bytes; input
   count and satoshi value are not used as BEEF-size proxies.
4. Pool growth consumes only surplus already present after the requested
   action and its exact incremental fee are funded. The wallet does not gather
   another input merely to manufacture change outputs.
5. An output below the preferred value is permitted when it is the only
   fundable remainder. The preferred value is not a dust rule and cannot turn
   a valid payment into `WERR_INSUFFICIENT_FUNDS`.
6. Legacy fragments migrate only on a caller-authorized `createAction`, only
   when their value exceeds their marginal input fee, and only within the
   configured per-action budget.
7. Action-batch workspaces reserve disjoint outputs and use the same change
   values and per-action shaping limits as the legacy `createAction` path.
8. Permission-token persistence retains delayed broadcast so a permission
   grant does not inherit network-broadcast latency. The funding policy makes
   queued change available only after preferred alternatives are exhausted.

## Defaults

| Setting                            |        Default | Purpose                                                                                                          |
| ---------------------------------- | -------------: | ---------------------------------------------------------------------------------------------------------------- |
| Default-basket target              |    144 outputs | Supports many independently planned actions without requiring one large fanout transaction.                      |
| Preferred output value             | 5,000 satoshis | Keeps a liquidity unit useful at fee rates materially above the historical 32-satoshi era.                       |
| New outputs per action             |              8 | Builds the pool progressively and bounds any one transaction's fanout and descendant BEEF footprint.             |
| Legacy migration inputs per action |              4 | Retires old fragments progressively without recreating 178-input permission transactions.                        |
| Pending-comparison threshold       |      16 inputs | Keeps the common settled path fast; above this point the planner measures alternatives by exact serialized cost. |

At the Wallet Toolbox default of 100 satoshis/kB, a 148-byte managed input adds
about 15 satoshis of fee and a minimal one-input/one-output transaction costs
about 20 satoshis. A 5,000-satoshi preferred unit is therefore roughly 250
minimal-spend fees at that rate. Even at 1,000 satoshis/kB it remains roughly
26 minimal-spend fees. The value is intentionally a liquidity target, not a
consensus or economic-dust boundary.

A completely filled default pool represents 720,000 satoshis. Wallets with a
smaller balance do not attempt to manufacture that reserve. They retain fewer
outputs, and a remainder below 5,000 satoshis is kept when that is the only
available shape.

## Funding and ancestry selection

For each action, storage loads unreserved managed change once and plans in this
order:

1. completed parents;
2. completed plus unproven parents;
3. completed, unproven, and sending parents.

Within each tier, the new surplus-only shape runs first. If that shape reports
insufficient funds, the same tier is immediately retried with the former
funding algorithm and the allocator's economic floor for its first remainder.
This is deliberately at least as permissive as the historical 32-satoshi
basket. An inability to create a preferred 5,000-satoshi change output is not
evidence that settled funds cannot pay the requested output.

The first successful plan is accepted immediately when it uses no more than 16
managed inputs. Above that threshold, later status tiers are also planned and
the wallet compares:

```text
serialized cost = planned transaction bytes + exact input BEEF bytes
```

The smallest measured plan wins. If proof retrieval needed only for comparison
is unavailable, that alternative receives an infinite comparison cost; the
already fundable baseline remains available. This optimization can therefore
improve latency and BEEF size but cannot become a new availability dependency.

Using a `sending` parent necessarily extends the unconfirmed BEEF chain and a
failed ancestor can invalidate its descendants. That is why it is last in the
normal order. It remains supported because refusing a fundable user action is
worse than reluctantly extending the chain after all safer liquidity is
exhausted.

## Progressive pool shaping

Explicit or fixed inputs can already cover the requested outputs and fee. In
that case the planner materializes the first change output directly from that
existing surplus before considering optional fragment migration. It does not
call the managed-change allocator merely to create pool outputs. This keeps
consolidations and externally funded actions on the same shaping policy while
preserving the invariant that pool growth never gathers compulsory inputs.
When the surplus cannot pay both the marginal output fee and the economic dust
floor, the bounded remainder stays in the transaction fee instead of causing a
compatibility retry to gather another input solely to manufacture change.

After compulsory funding succeeds, the planner may consume up to four
undersized outputs. A fragment is skipped when spending it would cost at least
its value. Optional migration never supplies a missing satoshi for the caller's
requested outputs and never runs when the basket is already at its target.

The resulting surplus is split into at most eight outputs and only when every
new output can meet the preferred value after paying the exact added output
fee. Otherwise the wallet keeps one output. Excess is distributed through the
existing randomized change algorithm, and ordinary output randomization still
applies. The policy therefore preserves the existing privacy intent and
non-uniform values whenever surplus exists instead of replacing it with a
fixed deterministic denomination scheme. When the available value is exactly
the sum of the preferred minima, equal minima are unavoidable; the wallet does
not create a smaller output merely to force cosmetic variance.

The target is based on healthy outputs (those at or above the basket's
preferred value), not raw output count. Consuming a legacy fragment and
creating a useful output moves the pool forward; merely retaining another
32-satoshi fragment does not make the pool appear healthy.

## Existing-wallet migration

The SQL and IndexedDB providers recognize only the exact historical untouched
default:

```text
basket name = default
target count = 144
minimum value = 32
```

Those baskets advance to a 5,000-satoshi preferred value during the normal
provider migration. Other basket names, custom target counts, and custom
minimum values are unchanged. The migration does not consolidate, sign, or
broadcast a transaction. Future `createAction` calls progressively consume at
most the configured number of fee-positive fragments and create useful change
only from real surplus.

The SQL data migration is intentionally one-way. Rolling code back does not
rewrite a migrated preference to 32 or fragment funds. Older code can still
read and honor the 5,000-satoshi basket value. SQLite writes the migrated
row's timestamp in UTC ISO form, matching incremental-sync query values and
keeping that metadata immediately sync-visible. MySQL retains its native
millisecond timestamp expression.

## Operator configuration

The defaults are suitable for a general wallet. Local Knex and IndexedDB
operators can tune the work budgets without rebuilding the package:

```ts
const setup = await Setup.createWalletKnex({
  ...args,
  managedChangePolicy: {
    maxOutputsPerAction: 8,
    migrationInputsPerAction: 4,
    pendingComparisonInputs: 16
  }
})
```

The same `managedChangePolicy` option is accepted by `StorageKnex`,
`StorageIdb`, `Setup.createStorageKnex`, and `SetupClient.createStorageIdb`.
The basket target and preferred value remain user-wallet settings and can be
changed through `wallet.setWalletChangeParams(count, satoshis)`.

Each policy limit accepts `-1`, with deliberately different meanings:

- `maxOutputsPerAction: -1` makes the basket target the only fanout bound;
- `migrationInputsPerAction: -1` permits all fee-positive legacy fragments in
  one authorized action;
- `pendingComparisonInputs: -1` disables optional pending-plan comparison, but
  pending funds remain available when earlier tiers are insufficient.

Unlimited modes can create large transactions or BEEF payloads and should be
used only by operators that have measured their workload. They do not remove
the wallet's economic-dust check, transaction validity checks, action-batch
reservation limit, or available-funding bound.

The official `wallet-infra` image exposes the same settings as validated
environment values:

```dotenv
WALLET_STORAGE_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION=8
WALLET_STORAGE_MANAGED_CHANGE_MIGRATION_INPUTS_PER_ACTION=4
WALLET_STORAGE_MANAGED_CHANGE_PENDING_COMPARISON_INPUTS=16
```

This lets a hosted Wallet Storage provider choose the policy without rebuilding
the image. Invalid, unsafe-integer, or out-of-range values fail startup instead
of silently falling back. The API and singleton Monitor roles must use the same
values so planning, reservation, and operator reporting describe one policy.

## Action batches and concurrent workspaces

An action-batch begin response carries the effective output and migration
limits when the provider supports them. Older and third-party providers can
omit the optional policy; clients then use the same defaults. Initial and
extended reservation selection prefers completed parents, then unproven, then
sending, while still reserving enough last-resort liquidity to avoid wedging a
workspace.

Workspaces remain isolated by explicit transaction-graph membership and their
reservations remain disjoint. Pool-shaping state is local to each plan; there
is no global in-memory "current batch" whose change can be consumed by an
unrelated action.

## Monitoring and rollout

`TaskReviewUtxos.reviewManagedChangeByIdentityKey(identityKey)` is a read-only
operator report. It returns:

- total and target managed-change counts;
- healthy and undersized counts;
- active action-batch reservations;
- completed, unproven, and sending parent counts;
- total satoshis and the preferred minimum.

Monitor has no signing authority and does not perform consolidation. This
keeps migration tied to normal user-authorized actions and makes rollout
observable without creating surprise transactions. The official Monitor admin
UI exposes the same report as the **managed-change liquidity (read only)** UTXO
review mode.

Recommended rollout checks are:

1. record the report before upgrade;
2. migrate the storage provider and confirm only exact legacy defaults changed;
3. exercise a small immediate action, a delayed permission action, and two
   concurrent action-batch workspaces;
4. confirm undersized count declines gradually and sending-parent use remains
   exceptional;
5. watch action input count, serialized BEEF bytes, fee, and broadcast failure
   rates before changing defaults or selecting an unlimited mode.

## Compatibility surface

No BRC-100 method, Wallet Wire method, Storage Server RPC method, or persisted
transaction format changes. The action-batch policy field is optional. Existing
custom basket settings remain authoritative. A same-tier compatibility plan,
followed by the retained pending-parent fallback, ensures the new preferences
do not add a refusal where the previous wallet could create an action.
