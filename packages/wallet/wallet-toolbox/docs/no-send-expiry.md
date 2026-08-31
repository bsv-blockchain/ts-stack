# Expiring `noSend` actions (BRC-177)

Wallet Toolbox implements the BRC-111 `nosend` module for wallet-enforced
expiry of BRC-100 `noSend` actions. It is built into the Node, browser, and
mobile Wallet Toolbox distributions; applications do not install a separate
permission module.

Use exactly one of these action labels:

```text
p nosend expiry seconds <duration>
p nosend expiry timestamp <unixSeconds>
p nosend expiry blockheight <height>
```

Values are canonical unsigned base-10 integers. A relative duration must be
greater than zero. Absolute timestamps and block heights must still be in the
future when the protected action is activated.

```ts
const offer = await wallet.createAction({
  description: 'Offer valid for five minutes',
  labels: ['p nosend expiry seconds 300', 'offer 42'],
  outputs: [
    {
      satoshis: 1000,
      lockingScript: recipientLockingScript,
      outputDescription: 'Offer payment'
    }
  ],
  options: {
    noSend: true
  }
})
```

The caller must set `noSend: true` and must not use `sendWith`,
`noSendChange`, or `returnTXIDOnly`. The wallet applies the same restrictions
when a signable action is completed through `signAction`.

When label permissions are enabled, Wallet Permissions Manager authorizes use
of the built-in module and obtains a spending preflight before creating its
on-chain funding transaction. Its normal amount-specific spending authorization
still applies to the protected action and always rechecks the current spending
ledger after prefunding. The funding transaction carries the same originator
and calendar-month attribution as the protected action, while accounting only
for its miner fee rather than its internal anchor output. This prevents an
unauthorized application from imposing even the funding transaction's miner
fee or evading monthly limits through repeated prefunding. The reserved labels
cannot be overridden by a custom permission module or asserted through
`internalizeAction`.

## What the wallet does

Before returning the protected action, Wallet Toolbox:

1. calculates the exact wallet funding required by its requested outputs,
   explicit inputs, and fee;
2. creates and immediately broadcasts a normal funding transaction containing
   a dedicated managed-change output;
3. requires processor acceptance of that funding transaction;
4. creates the protected transaction with that output as its only
   automatically selected wallet input and with no wallet change; and
5. signs and durably stores a one-input reclaim transaction to a fresh
   `default`-basket output.

The wallet returns the protected transaction to the caller but never
broadcasts it. The funding transaction may have ordinary change because it is
already on the network; significant wallet change is therefore not held inside
the unbroadcast transaction.

For `seconds`, activation occurs after prefunding and the absolute deadline is
stored before the action is returned. Restarting the wallet does not restart
the duration. A signable action is already active while it waits for
`signAction`, but an unsigned expiry can release its anchor locally because no
valid anchor signature has been exposed.

After a signed action expires, the active storage monitor first requires both
an explicit `unknown` target verdict and a conclusive unspent-anchor result.
Service errors or ambiguous status defer action. The monitor then atomically
activates the pre-signed reclaim and retries normal network submission. The
reclaim output remains unavailable for wallet funding until a locally
validated Merkle proof establishes that the reclaim won. A processor rejection
does not release the anchor: the lifecycle remains quarantined for proof
reconciliation because another submission may already have reached the network.
A conclusive spent-anchor verdict is likewise quarantined; if the conflicting
spend later disappears, reclaim resumes only after fresh explicit `unknown`
target and unspent-anchor verdicts.

Seeing the protected transaction as known or mined permanently stops a new
reclaim and moves it into ordinary proof tracking. If a reclaim was already
submitted when the target appears, the monitor stops further reclaim retries
but retains both transactions for proof tracking. Only a locally validated
proof finalizes either winner. A processor status by itself is never reported
as final.

`abortAction` cancels an unreleased action locally. For a released action it
durably requests immediate revocation through the same guarded reclaim path;
it does not clear the anchor reservation. An already observed target is
protected and returns `aborted: false`.

## Storage, monitors, and upgrades

Expiry metadata, the signed reclaim, and lifecycle state are synchronized with
the action. State merging is monotonic, so a backup with a newer wall clock
cannot revive an older lifecycle state. Only the provider named by the user's
synchronized `activeStorage` value may activate a reclaim, and compare-and-set
updates ensure that concurrent monitor processes intentionally create one
reclaim record. Synchronized reclaim outputs remain quarantined unless the
local lifecycle has proven the reclaim winner, even when transaction and output
updates arrive from different devices.

The default Wallet Toolbox monitor includes the expiry task. A remote active
storage service owns monitoring; browser and mobile clients do not compete
with it. Operators must migrate the active storage database and run the normal
default monitor before accepting BRC-177 actions. The capability handshake
rejects an older storage server before the wallet creates the funding
transaction.

Knex storage gains nullable transaction lifecycle columns plus expiry and
reclaim-transaction indexes. IndexedDB schema version 5 adds the corresponding
state and reclaim-transaction indexes. Existing actions and ordinary `noSend`
behavior are unchanged; no data rewrite is required.

Funding and reclaim network fees are paid by the wallet owner. Wallet Toolbox
reserves reclaim fees at the greater of its configured fee rate or 1,000
satoshis per kilobyte and rejects an anchor that would not leave an economic
reclaim output.

## Application responsibility

Action labels are wallet metadata and are not committed into the transaction
or automatically delivered in BEEF. An application that gives the transaction
to a recipient must communicate the deadline separately. If the deadline must
be authenticated, bind it to the transaction or anchor outpoint in the
application protocol.

Broadcast with enough margin for the wallet's configured status services to
observe acceptance. Expiry starts a double-spend reclaim; consensus finality
comes only from the transaction that is mined and proven.
