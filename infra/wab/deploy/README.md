# WAB Kubernetes deployment

These manifests are operator templates. They do not create credentials and they
do not deploy themselves. Keep the WAB image tag paired with the digest verified
by the repository's infrastructure release workflow.

The sample MySQL Deployment is classified `example-not-production`.
Production must replace it with a managed database or operator-owned stateful
workload that defines replication, upgrades, disruption handling, capacity
alerts, encrypted backups, and restore tests.

Create `wab-secrets` through the cluster's secret-management path with:

- `db-password`;
- `mysql-root-password`;
- any enabled identity-provider credentials;
- any optional faucet/storage private material.
- optionally, `wab-presentation-key-encryption-key`, exactly 32 random bytes
  encoded as 64 hexadecimal characters, mapped to
  `WAB_PRESENTATION_KEY_ENCRYPTION_KEY`, when enabling the staged vault;
- `wab-admin-token` with at least 32 random characters when operator UMP
  pinning and phone-association restoration are enabled.

Do not commit Secret manifests or literal values. Non-secret database coordinates
live in `wab-config`. Replace them when using a managed database and remove the
sample MySQL Deployment.

The WAB process applies migrations before it listens. Kubernetes startup,
readiness, and liveness checks use the public `/info` endpoint; reaching it proves
the process completed startup and bound port 8080. The application container runs
as an unprivileged user with a read-only root filesystem and no Linux
capabilities.
The five-second pre-stop delay lets endpoint withdrawal propagate before
`SIGTERM`; WAB then drains HTTP and closes Knex. The sample records its
disruption and autoscaling posture explicitly but does not install a
PodDisruptionBudget or HPA until shared abuse-control and session behavior has
been operator-validated. The hostname topology preference is ready for that
replica-safe deployment.

WAB remains a public protocol service. Wildcard, credential-free CORS is the
default so deployed apps, webviews, mobile clients, and future callers can use it.
Exact-origin allowlists and credentialed exact-origin deployments are explicit
operator choices; CSP is not an API authorization mechanism.

Back up the database and record the current schema and image digest before a
rollout. Apply the database change first, wait for its probes, then update the WAB
digest. Roll back to the prior digest only when its schema compatibility is
verified; otherwise restore through the database recovery runbook.

The presentation-key migration is additive and leaves existing plaintext rows
unchanged, so it can be applied before or during a rolling WAB deployment. The
sample secret reference is optional: with no mode or key, the new binary stays
in `legacy` mode and behaves like the prior server. The HTTP API remains
identical throughout this rollout.

To enable database-at-rest defense in depth, first create and back up the vault
key, then roll out the new binary with
`WAB_PRESENTATION_KEY_ENCRYPTION_MODE=dual-write`. Each startup idempotently
backfills ciphertext and keyed lookups while retaining plaintext, and reads
also fall back to plaintext rows written by an old replica. After every old
replica is drained, restart the new binary once more in dual-write mode and
verify a successful reconciliation log. Only then set the mode to `encrypted`;
the next startup redacts plaintext before the server begins listening.

Never run an old image after encrypted cutover. A rollback to an old binary
requires a controlled plaintext restore using the same key. Never rotate or
lose the vault key without first re-encrypting every stored credential; a
database backup without the matching key cannot restore redacted accounts.

The earlier support migration adds `users.umpTokenOutpoint`,
`phone_change_sessions`, and `phone_change_history`. The preceding WAB binary
ignores these additive objects, so an image rollback may retain the migrated
schema. Do not run the down migration after any phone change: it deletes the
only automated association-restore history.
