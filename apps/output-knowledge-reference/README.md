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

The default producer preserves the original direct-index fixture behavior. An
explicit admission installation connects the same interactive page to actual
Engine/Mongo topic admission, retained original receipts and a recoverable SQLite
lookup projection. A saved command precedes its first admission effect; recovery
repairs its original bounded groups after a lost admission or projection reply.
Source withdrawal does not spend the output, and this producer cannot reintroduce
an output its admission store already knows was spent. A separate automated
proposal pipeline composes non-final reservation, ordinary admission and receipt
recovery. Private publication, paid acquisition, protected release, covenant
purchase flows and root-host eviction remain further workbench integrations.

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

For actual admission, install an isolated loopback Mongo replica set and explicitly
set `REFERENCE_ADMISSION_URI` to its single loopback seed URI and
`REFERENCE_ADMISSION_DATABASE` to a fresh name beginning `output_reference_`.
Use a separate `REFERENCE_DATA` directory for this installation. Both roles may
share the replica set while retaining independent node scopes and commands.
Initialization requires `REFERENCE_CREATE=1`; restart with the same Mongo database,
role, identity and SQLite files and omit it. **Recover saved producer command**
finishes retained work. A missing Mongo ownership marker or command namespace
refuses recovery instead of creating replacement custody. Mongo admission and
SQLite projection are separate commits: the original command reconciles the gap,
so a topical receipt alone does not imply lookup visibility or mining.

Use the [workbench guide](../../docs/guides/output-knowledge-workbench.md) for the
expected results, storage boundaries and qualification limits.

## Validation

Run `pnpm --filter output-knowledge-reference-app test` for real Script/SPV,
progressive snapshot and authenticated HTTP/SQLite client recovery checks.
The proposal pipeline test starts an isolated three-member MongoDB 8.2.6 replica
set through the workspace's existing audited test fixture. Its first run needs
the pinned Mongo binary available or downloadable; it never contacts an existing
Mongo database. The fixture closes its own processes, connections and files.
Run just that composition with
`pnpm --filter output-knowledge-reference-app exec vitest run test/proposalPipeline.test.ts`.
It records a signed private proposal, rejects an unauthorized reader and invalid
transaction evidence, loses delivery after a real Engine commit, reopens both
adapters and recovers the original receipt without a new submission. Recovery
also works with discovery/evidence access unavailable and the original manifest
expired. Restoring caller authorization is still required to disclose the result.

`pnpm --filter output-knowledge-reference-app test:browser` builds the production
bundles and runs both producer modes in Chrome/Chromium with native IndexedDB,
two actual local providers, two clients, page-close recovery and independent
source membership. Its admission run owns a fresh three-member Mongo fixture;
it never contacts an operator's database. It requires
free ports 4174 and 4175 and closes only the servers/profile it creates.
The browser checks write review screenshots under `artifacts/reference-workbench/`
and `artifacts/reference-workbench-admission/`. Run only the admission profile with
`pnpm --filter output-knowledge-reference-app test:browser:admission`.
`test/referenceAdmission.test.ts` separately proves actual admission-driven
progressive/live native recovery, both lost-reply boundaries, physical drain,
changed-subject refusal and missing-custody recovery refusal.

The proposal test exercises ordinary Topic Manager admission on the pinned
synthetic chain. It does not establish mining, current unspentness, protected
content delivery, interactive private subscriptions or native mobile OS
qualification. Those remain separate checkpoint work.

Both lookup hosts install `LookupResponseDisclosure` with the same current
policy, durable sessions and physical work budget as their provider. Their actual
authenticated responses therefore recheck session/guard state after signing at
native enqueue. This workbench's public fixture identities are demonstration
inputs; the installed port is where a deployment supplies its own data and control
access policy. The separate proposal admission/recovery test is unchanged.
