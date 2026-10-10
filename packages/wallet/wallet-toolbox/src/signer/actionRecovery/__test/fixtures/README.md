# Local recovery fixtures

`revenue-listing-program.bin.gz` contains the 39,580-byte frozen BRC-197 program
from BRC PR 284, commit `9dade70dd17d48efb087a2c5da56bb53c164383e`.
The decompressed SHA-256 is
`ae47a6cc9bdc955d6aa73cdc459bbd6bbe493419dcf3ed3fc952a95c8c510716`;
the SDK family constructor checks this identity. The same program appears in the
SDK's frozen transaction corpus. It is a test artifact, not a new script family.

The six-route test uses independently derived BRC-100 authority keys from public
fixture roots 41, 42 and 43, and an isolated copy of the existing wallet fixture
for actual allocation and signing. It never broadcasts. Its locally created
descriptor labels synthetic test scope; this test checks wallet/Script composition,
not a selected production chain, authorized genesis lineage or private delivery.

`crash-worker.cjs` opens only the isolated database and public fixture key provided
by its parent test. SIGKILL boundaries exercise actual process loss and SQLite
reopening. No live wallet or operator credentials are read.
