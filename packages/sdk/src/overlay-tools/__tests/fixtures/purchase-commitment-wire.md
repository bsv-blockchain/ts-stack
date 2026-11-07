# Frozen purchase-commitment packets

`purchase-commitment-wire.json.gz` retains the two unchanged covenant acquisition
examples from `overlays/media/0192-0199/wire-vectors.json.gz` in
[BRC PR295](https://github.com/bsv-blockchain/BRCs/pull/295), immutable source
`1b9a75e497b5856675af1ce01fd86843c37d07f9`. It contains public synthetic identities,
requests, signed terms, submit BEEF, pending envelopes and signed delivered
envelopes. No transaction, signature, secret context or commitment was changed.

The source archive SHA256 is
`a8f130d7b0fd89fb301e9327ecef2eb5f39374efb6ade9d7fc0b88c11c63e2eb`.
The retained fixture SHA256 is
`9451fecbcc446e507b3c3a78355e43dc6f31ab806aa01ea8f94b3282bca04502`.
The test checks both provenance and retained bytes.

The retained object has `source` metadata and `cases`. Cases are exactly the
source acquisitions whose mode is `listing-covenant`, retaining fields `buyer`,
`prepare`, `terms`, `submit`, `pending` and `envelope`. JSON is encoded with sorted
keys, compact separators and unescaped Unicode, then gzip with mtime zero.
Reimport from the immutable source; do not regenerate signatures or edit these
packets to fit an implementation.

These vectors qualify representation, original-contract/signature binding and
full-preimage commitment calculation. They do not qualify complete Script
execution, lineage, selected-chain placement, alias recovery, wallet custody or
LCH usability. Those remain separate integration gates.
