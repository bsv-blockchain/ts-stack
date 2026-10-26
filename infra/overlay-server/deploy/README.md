# Overlay Kubernetes deployment

These manifests are secure starting points, not a live environment definition. Pin
every application image to the release tag and digest verified by the repository
release workflow. The checked-in digest is an example release and is not updated by
an application rollout.

The MySQL and MongoDB Deployments are explicitly classified
`example-not-production`. Production must replace them with managed databases
or operator-owned stateful workloads that define replication, upgrades,
disruption handling, capacity alerts, encrypted backups, and restore tests.

Before applying the manifests, create two secret objects through the operator's
secret manager or deployment system:

- `overlay-secrets`: `knex-url`, `mongo-url`, `server-private-key`,
  `arc-api-key`, and `admin-token`. When `mandala-enabled` is `true`, also
  supply independent `mandala-verifier-private-key` and
  `mandala-admin-private-key` values; neither may equal the server key.
- `overlay-database-secrets`: `mongo-root-user`, `mongo-root-password`,
  `mysql-database`, `mysql-user`, `mysql-password`, and
  `mysql-root-password`.

Do not commit Secret manifests or literal credentials. Update `overlay-config`
with the public node name, hosting URL, wallet-storage URL, network, and GASP
choice. The API remains public and credential-free wildcard CORS by default;
origin allowlists are an explicit operator option, not a deployment prerequisite.

Mandala is disabled in the sample ConfigMap. Its bundled static denylist is
only a reference/local adapter. A production regulated-token deployment must
wire an authoritative screening provider in application code; merely changing
`mandala-enabled` and leaving a static empty list is not a production screening
control.

The application image runs directly with Node on port 8080. Startup and liveness
use `/health/live`; readiness uses `/health/ready`, which includes configured
database and engine checks. The application filesystem is read-only and the
container runs without Linux capabilities. Database pods retain writable PVCs.
The five-second pre-stop delay lets endpoint withdrawal propagate before
`SIGTERM`; the process then stops synchronization and maintenance work, drains
HTTP, and closes both data stores. The sample is an explicit
maintenance-controlled singleton. Do not add a disruption budget or
autoscaling until background-work leadership and shared BRC-103 sessions have
been implemented and validated. A hostname topology preference is already
present for that future replica-safe state.

Back up both databases before changing a schema or image. Roll out the databases
separately from the application, wait for their probes, then update the
application digest.

Treat the 2026-09-17 topical-uniqueness and 2026-09-20 `spentBy` migrations as
one maintenance boundary:

1. Stop application writes and drain the existing replica.
2. Take a coordinated, restorable MySQL and MongoDB backup, retaining
   point-in-time logs or equivalent evidence through the maintenance window.
3. Preflight exact duplicate `outputs` keys `(txid, outputIndex, topic)` and
   `applied_transactions` keys `(txid, topic)`. Reconcile every duplicate from
   transaction, topic, and lookup evidence; never auto-delete or arbitrarily
   select security-relevant state. The uniqueness migration intentionally
   fails while duplicates remain.
4. Apply all migrations before serving writes, with topical uniqueness before
   the additive `spentBy` column. Verify both unique constraints and the column,
   then start the new image and exercise submit and lookup before restoring
   traffic.

Prefer roll-forward after writes have used `spentBy`. An older image does not
know these two migration names, so pointing a prior digest at the upgraded
database can fail migration-list validation. If an old image is unavoidable,
stop writes and choose one of these coordinated paths:

- Use the new release's migration source to reverse `spentBy` and then topical
  uniqueness before starting the old image. First export and verify an
  immutable reconciliation record containing every affected output's `txid`,
  `outputIndex`, `topic`, `spent`, and `spentBy`; retain it through the next
  upgrade and reconcile it against transaction and topic evidence before
  re-enabling writes.
- Restore the old image together with the coordinated pre-migration MySQL and
  MongoDB backups.

Never perform an image-only rollback, drop `spentBy` without preserving its
evidence, or restore only one database. Keep writes disabled until the selected
rollback and reconciliation path is complete.
