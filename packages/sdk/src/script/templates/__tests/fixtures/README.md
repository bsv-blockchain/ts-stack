# Revenue listing fixtures

The codec and spend fixtures come from BRCs commit
`9dade70dd17d48efb087a2c5da56bb53c164383e`, `tokens/media/0197`.
`revenue-listing-transactions.json` is the original `transactions.json` and
`raw-transactions.json.gz` is copied without modification. The fixture loader
checks the compressed archive's SHA-256 from that manifest and each transaction's
actual ID. The smaller codec fixture extracts the authorized genesis output from
that same archive. The generator and independent BitcoinX oracle remain in the
pinned BRC source; this directory does not silently regenerate expected values
from the implementation under test.

All keys and funding data are disclosed synthetic test material. These tests do
not use a funded wallet or live network, prove mainnet inclusion, or qualify a
BRC-100 wallet. A funded copied-script merge is a positive Script fixture but is
not a valid lineage; the construction layer intentionally does not substitute
for the separate domain verifier.
