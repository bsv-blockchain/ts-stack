# Frozen revenue-listing lineage evidence

These four files are copied unchanged from
`bsv-blockchain/BRCs` commit
`9dade70dd17d48efb087a2c5da56bb53c164383e`, under
`tokens/media/0197/`. They accompany the proposed BRC-197 executable family:

- `transactions.json`: upstream manifest, including the public synthetic fixture
  keys, transaction identities, expected Script outcomes and evidence digests.
- `lineage-package.json.gz`: the complete authorized history through purchase,
  both split branches, merge, payout and unanimous amendment.
- `lineage-boundary.json.gz`: a separately funded copy and seller-authorized
  merge that conserves value in Script but fails the shared-genesis domain rule.
- `raw-transactions.json.gz`: the original transaction corpus, including
  retirement and its external funding, for dedicated authority integration.

The fixture loader checks the manifest's SHA-256 of each **decompressed lineage
JSON document** before parsing it. The authority loader checks the manifest's
SHA-256 of the **compressed raw transaction archive**, then checks each selected
raw transaction against its declared identity. The SDK's route tests also carry
and execute that corpus independently.

All keys and funds are synthetic and public. The local helper extends the frozen
easy-work checkpoint with checked synthetic headers and labels the context
accordingly. It does not assert inclusion on a production chain. Tests that
change genesis reauthorize it with disclosed key 41 to distinguish domain-layout
validation from signature rejection; they make no claim that their modified
funding signatures are valid.

Production modules never import these files or the test helper. The runtime
requires an explicitly supplied, authenticated executable and an installed
immutable chain-view resolver.
