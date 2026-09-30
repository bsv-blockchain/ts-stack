# Output knowledge reference workbench

This application demonstrates progressive, authenticated live lookup and durable
client recovery for the second implementation checkpoint. The larger
BRC-192–199 composition is still being assembled.

The initial composition connects a trusted fixture producer, a durable SQLite
lookup index and session store, the authenticated Overlay Express lookup
companion, and independent application clients. The client controller accepts
either SQLite or native IndexedDB stores. It uses the ordinary SDK evidence
verifier and output runtime; discovering a record never authorizes a payment.

The included transactions are genuinely signed P2PKH transactions. Their BEEFs
are checked against a fixed synthetic chain with checked easy-PoW header
ancestry. Every key and synthetic value is public test material. The chain is
not mainnet or a consensus-node substitute. This fixture cannot protect real
assets, authorize a production user, or receive real funds.

The producer can publish three independent records, spend the first to create a
replacement, withdraw the other from one source, and republish the old output.
The intended demonstration separates source membership from verified spend
knowledge: withdrawing a row is not a spend, and republishing a spent output
does not make it current. Each provider has its own identity, index and retained
sessions. A disconnected client resumes its original local control record and
cursor, rather than inventing another Open.

The producer currently verifies the fixed evidence before explicitly updating
the lookup read model. This is not the ordinary topic-admission bridge. Private
publication, paid acquisition, protected release, covenant purchase flows and
root-host eviction remain separate integrations under construction.

## Fixture provenance

`src/fixtures/chain.json` is the minimal A/AC/Q/X transaction and base-chain subset
of the repository's BRC-192 reconciliation corpus in
`packages/application/output-knowledge/test/fixtures/reconciliation-vectors.json`.
It preserves the exact signed bytes, header hashes and inclusion paths.
Its public transaction signing key is 63. The application authentication
identities are separate public fixture keys.

## Run

Build the application and its workspace dependencies with the repository toolchain:

```sh
pnpm --filter output-knowledge-reference-app... build
```

In separate terminals, initialize the two independent local hosts:

```sh
REFERENCE_CREATE=1 REFERENCE_HOST=one pnpm --filter output-knowledge-reference-app serve
REFERENCE_CREATE=1 REFERENCE_HOST=two pnpm --filter output-knowledge-reference-app serve
```

Open `http://127.0.0.1:4174` in two tabs, select Alice and Bob respectively,
check **Include the other host**, and start their new views. Their IndexedDB
databases are separate. Follow the producer commands and recovery instructions
on the page. Host two has its own producer page at `http://127.0.0.1:4175`.

The servers store their SQLite databases under the ignored `reference-data`
directory. Set `REFERENCE_DATA` to an absolute directory to choose another
location. On restart, omit `REFERENCE_CREATE` to open the existing database.
The loopback server bounds all requests to 600 per source address per minute,
before authentication work, and keeps rejection responses uncacheable.
Missing or inconsistent state is an error; never clear it to simulate recovery.
A new browser workspace name starts a separate experiment; **Resume saved view**
opens existing control records and does not rediscover a replacement contract.

Use the [workbench guide](../../docs/guides/output-knowledge-workbench.md) for the
expected results, storage boundaries and qualification limits.

## Validation

Run `pnpm --filter output-knowledge-reference-app test` for real Script/SPV,
progressive snapshot and authenticated HTTP/SQLite client recovery checks.
`pnpm --filter output-knowledge-reference-app test:browser` builds the production
bundles and runs Chrome/Chromium with native IndexedDB, two actual local providers,
two clients, page-close recovery and independent source membership. It requires
free ports 4174 and 4175 and closes only the servers/profile it creates.
The browser check writes a review screenshot under
`artifacts/reference-workbench/workbench.png`.

This is not ordinary Topic Manager admission, a mainnet spend, protected-content
delivery or native mobile OS qualification. Those remain separate checkpoint work.
