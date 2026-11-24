# Complete positive witness construction inputs

`revenue-listing-profile-spend.json.gz` retains the unchanged descriptor, genesis
raw transaction, activation Atomic BEEF, buyer-A purchase Atomic BEEF and its full
signed-result commitment from BRC PR295 at
`1b9a75e497b5856675af1ce01fd86843c37d07f9`. Source archive SHA256:
`a8f130d7b0fd89fb301e9327ecef2eb5f39374efb6ade9d7fc0b88c11c63e2eb`.
The 35019-byte extracted fixture has SHA256
`bdcdb9f8debba36153fd699ba3321427c6f0ff127c141329790d91591b69bc7f`.

The fixture also copies the archive's publicly disclosed offline seller and
external-funder toy identities/scalars. They have no production authority or
value. Tests place the seller root exclusively inside ProtoWallet and receive
only child public keys and DER signatures; the builder receives no private
scalar. The separate test funder signs its own ordinary P2PKH input.

Tests rebuild normal canonical activation and purchase witnesses without changing
headers, outputs, funding signatures or transaction identities. They compare
exact bytes and the independent signed purchase commitment, then execute every
complete input using the SDK interpreter with a 128 MiB memory bound. Additional
normal positive split, payout and both retirement transactions use the same
immutable descriptor. A one-through-eight-recipient property and an eight-recipient
activation/purchase/payout construction exercise the exact public programs.
Each recipient also spends its exact child P2PKH payout through the protected
wallet interface, without deriving a private child outside that wallet.
Those constructed sources are not represented as authenticated BRC77 genesis or
verified selected-chain histories. The full 300-run active-route property varies
valid split amounts, payout quanta, fees and expiry locks without lowering controls.

This is component qualification, not a mutation/malleability reproduction or a
native miner/wallet/lineage/chain-currentness qualification. No private child
scalar is derived or exported by the fixture builder or constructor.
