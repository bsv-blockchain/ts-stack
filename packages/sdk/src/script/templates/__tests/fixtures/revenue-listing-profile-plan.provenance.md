# Immutable profile planner inputs

`revenue-listing-profile-plan.json.gz` retains the unchanged authorized genesis,
public-link activation and buyer-A purchase transactions from BRC PR295 at
`1b9a75e497b5856675af1ce01fd86843c37d07f9`. Its descriptor is unchanged, and its
purchase arguments are extracted from the original purchase receipt. The source
wire archive has SHA256
`a8f130d7b0fd89fb301e9327ecef2eb5f39374efb6ade9d7fc0b88c11c63e2eb`.
This 12852-byte extracted fixture has SHA256
`840a70d49b44fd7a885af0685de91367b095d754058227fc5a69bed6420448c7`.

Planner tests compare the mandatory activation and purchase outputs with these
unchanged corpus transactions. Arithmetic tests for split, payout and retirement
do not establish a complete signed transaction, Script acceptance, genesis
authorization, chain placement, delivery or wallet/miner integration. No
transaction variant, witness or signature is regenerated in this fixture.
