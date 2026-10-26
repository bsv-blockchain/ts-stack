# Output knowledge reference workbench

This application demonstrates progressive, authenticated live lookup and durable
client recovery for the second implementation checkpoint. The accompanying native compositions demonstrate the BRC-192–199 private
acquisition, covenant purchase and independent root-host workflows. Complete
qualification of the published implementation branch is still required.

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
recovery. The optional private-state page additionally installs author-signed proposal
publication and recipient-authorized live lookup with local intent deadlines. Paid
acquisition, protected release, covenant purchases and root-host eviction have
separate native integration demonstrations and are not enabled by that page.

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
The native two-host test prepopulates both independent indices before connecting,
forces progressive pages, waits for each snapshot's completion, then follows live
source-local withdrawal and an independently verified spend. It also publishes a
framed but contradictory raw BEEF through an actual authenticated host and requires
the client to reject it while preserving its original Bitcoin facts. Closing and
reopening the client's SQLite journal and controls retains both hosts' original
selections and cursors. A provider signature authenticates a report; it does not
make its transaction bytes true.
The proposal pipeline test starts an isolated three-member MongoDB 8.2.6 replica
set through the workspace's existing audited test fixture. Its first run needs
the pinned Mongo binary available or downloadable; it never contacts an existing
Mongo database. The fixture closes its own processes, connections and files.
Vitest first obtains that fixed binary in its global setup, before isolated suite
workers start. This prevents concurrent initial downloads from contending for
the same binary lock. Each suite still starts and closes its own original replica
set; the preflight neither starts a database nor reuses another suite's database.
Run just that composition with
`pnpm --filter output-knowledge-reference-app exec vitest run test/proposalPipeline.test.ts`.
It records a signed private proposal, rejects an unauthorized reader and invalid
transaction evidence, loses delivery after a real Engine commit, reopens both
adapters and recovers the original receipt without a new submission. Recovery
also works with discovery/evidence access unavailable and the original manifest
expired. Restoring caller authorization is still required to disclose the result.

The compound profile now also runs the opt-in client in
`src/referenceProposalClient.ts` through the actual authenticated lookup router.
It receives an accepted private proposal, follows the durable finalizing state
after an actual Engine/Mongo commit whose reply is lost, then reopens both its
native client stores and the provider. It receives the recovered finalized state
through its original lookup session without another Open, even after the original
capability and proposal intent have expired. Discovery and the evidence resolver
remain offline during admission recovery. The same live session observes another
proposal become active and then expire at its exclusive lifetime boundary; this
expiry makes no Engine submission or evidence resolver call. A host's finalized assertion remains
separate from Bitcoin mining evidence and current unspentness.

This client accepts the same durable journal/control adapter interfaces as the
ordinary client, so SQLite and IndexedDB implementations can be installed
explicitly. Version-one proposal observations retain the signed proposal service
name; capability discovery distinguishes its topic and lookup roles by
`(kind,name)`. The combined HTTP routers share one authentication session owner.
The original interactive page retains its final-output producer. The additional
`proposal.html` page installs this same proposal client with native IndexedDB; see
the private-state installation below.

`pnpm --filter output-knowledge-reference-app test:browser` builds the production
bundles and runs both final-output producer modes plus the private-state profile
in Chrome/Chromium with native IndexedDB,
two actual local providers, two clients, page-close recovery and independent
source membership. Its admission run owns a fresh three-member Mongo fixture;
it never contacts an operator's database. It requires
free ports 4174 and 4175 and closes only the servers/profile it creates.
The browser checks write review screenshots under `artifacts/reference-workbench/`,
`artifacts/reference-workbench-admission/` and `artifacts/reference-workbench-proposals/`. Run only the admission profile with
`pnpm --filter output-knowledge-reference-app test:browser:admission`.
`test/referenceAdmission.test.ts` separately proves actual admission-driven
progressive/live native recovery, both lost-reply boundaries, physical drain,
changed-subject refusal and missing-custody recovery refusal.

The proposal test exercises ordinary Topic Manager admission on the pinned
synthetic chain. It does not establish mining, current unspentness, protected
content delivery or native mobile OS qualification. The separate private-state
browser profile checks interactive private subscriptions and intent expiry.

Both lookup hosts install `LookupResponseDisclosure` with the same current
policy, durable sessions and physical work budget as their provider. Their actual
authenticated responses therefore recheck session/guard state after signing at
native enqueue. This workbench's public fixture identities are demonstration
inputs; the installed port is where a deployment supplies its own data and control
access policy. The separate proposal admission/recovery test is unchanged.

## Private-state browser installation

Build as above. Install an isolated loopback Mongo replica set with a fresh database
whose name begins `output_reference_`, a separate data directory, and a locally
trusted TLS certificate/key for `127.0.0.1`. The certificate must be trusted by both
the browser and Node; use `NODE_EXTRA_CA_CERTS` for a fixture CA if necessary. Set
`REFERENCE_ADMISSION_URI`, `REFERENCE_ADMISSION_DATABASE`, `REFERENCE_DATA`,
`REFERENCE_TLS_CERT` and `REFERENCE_TLS_KEY` to that installation, then run:

```sh
REFERENCE_CREATE=1 pnpm --filter output-knowledge-reference-app serve:proposals
```

Open `https://127.0.0.1:4176/proposal.html` in two tabs, choose Alice and Bob with
the same workspace, and start their independent views. Publish a working document
from Alice and observe automatic delivery to Bob. Take Bob offline, publish another
document, then reconnect him through his original retained subscription. Each
fixture publication creates a new channel containing at most 128 UTF-8 payload
bytes, with both fixture participants as recipients and a 15-second author-intent
lifetime. It neither spends nor finalizes a Bitcoin transaction.

Hide Bob's tab past the intent deadline, then return. The UI clears its activity
indication immediately on visibility loss and re-evaluates before displaying
activity again. Durable host expiry and locally valid intent appear separately.
The bounded presentation timer is not a source of Bitcoin facts or wallet authority.
Close the tab and use **Resume saved view** with the same account/workspace. Stop
and restart the provider with the same Mongo database, SQLite file, identity and
TLS installation, omitting `REFERENCE_CREATE`, then resume again. Saved lookup
contracts and sessions are recovered without another Open or capability discovery.
The host scheduler observes and durably retires expired heads; missing or inconsistent
custody refuses recovery. Drain its physical work before closing either store.

Before the first publication request the client saves the exact signed request and
selected contract in a separate IndexedDB outbox. **Retry saved request** retries
that operation; an unanswered attempt blocks creating a replacement until its
original acknowledgement is retained. This outbox uses its original sealed capacities
on both creation and reopening. Public fixture keys provide no production confidentiality
or authentication. Replace the installed author/recipient policy, key custody, TLS
and chain context deliberately for a production application.

`pnpm --filter output-knowledge-reference-app test:browser:proposals` builds and
runs this profile alone. Its harness owns a fresh MongoDB 8.2.6 replica set, a
one-day loopback TLS certificate, the private provider process and two native
IndexedDB clients. Only that isolated fixture browser accepts its generated TLS
certificate; there is no global TLS bypass. It checks live delivery, missed-state
reconnect, hidden-tab expiry, page-close recovery and provider restart, requiring
exactly the two original Opens and no browser exceptions. It closes its processes
and removes its temporary files. Ordinary finite lookup, public state and BRC-170
behavior retain their existing defaults.
