# External Paymail specifications

This package implements Paymail capabilities but does not republish external
specification documents. Consult the authoritative upstream sources instead:

- [Money Button Paymail specifications](https://github.com/moneybutton/docs/tree/master/docs)
- [Tokenized transaction negotiation](https://github.com/tokenized/pkg/blob/master/bsvalias/NegotiationTransaction.md)

The local `ordinals/` document was authored in the original TS Paymail project
and remains part of this package.

Security note: the deployed legacy P2P signature covers only the transaction
ID. It is not proof of the route recipient, reference, sender-handle context,
or endpoint authority. Implementations must bind transaction outputs to their
own recipient/reference state and enforce durable replay handling. Adding that
context to the signature requires a new versioned protocol preimage.

The package's historical `requestSenderValidation` discovery flag reuses BRFC
`6745385c3fc0`. The authoritative upstream document defines that code for
signed and timestamped Basic Address Resolution requests; it does not define a
P2P-transaction sender-authentication capability. Existing package behavior is
retained for wire compatibility, but consumers must not infer timestamp,
replay, recipient, reference, or endpoint authentication from that flag.

Transaction Negotiation v1 contains no authenticated sender envelope. Its
expiry and timestamp communicate peer intent but do not authorize a thread.
Receivers must authenticate and authorize negotiations through their own
policy, enforce freshness/replay and supported-protocol rules, validate every
transaction/proof, and treat reply destinations and tokens as untrusted.
