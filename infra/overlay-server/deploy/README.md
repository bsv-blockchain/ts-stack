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
  `arc-api-key`, and `admin-token`.
- `overlay-database-secrets`: `mongo-root-user`, `mongo-root-password`,
  `mysql-database`, `mysql-user`, `mysql-password`, and
  `mysql-root-password`.

Do not commit Secret manifests or literal credentials. Update `overlay-config`
with the public node name, hosting URL, wallet-storage URL, network, and GASP
choice. The API remains public and credential-free wildcard CORS by default;
origin allowlists are an explicit operator option, not a deployment prerequisite.

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
application digest. Roll back by restoring the prior digest; restore data only
under the database engine's documented recovery procedure.
