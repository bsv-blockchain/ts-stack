# Wallet infrastructure Kubernetes samples

These files demonstrate the workload contract; they are not a production
environment. Replace the checked-in application image with the release tag and
digest verified for the source revision being deployed.

Create `wallet-secrets` and `mysql-secrets` through the operator's secret
manager. `wallet-secrets` supplies `SERVER_PRIVATE_KEY` and
`KNEX_DB_CONNECTION`; `mysql-secrets` supplies `MYSQL_ROOT_PASSWORD`. Never
commit either Secret object or a literal credential.

The wallet application completes storage migration and initialization before it
starts serving port 8080. Its public root response is used for startup,
readiness, and liveness checks. The application runs without capabilities as a
non-root user on a read-only root filesystem. MySQL retains a writable PVC and
has separate startup, readiness, and liveness checks.

Wallet Storage is a public protocol service. Its default browser policy remains
credential-free wildcard CORS, including opaque origins. Configure an exact
allowlist only when the deployment intentionally serves a closed caller set.

Before rollout, record the current image digest and database schema, take and
verify a database backup, and confirm sufficient PVC capacity. Roll back the
application digest only when the prior version supports the current schema;
otherwise follow the database restore procedure first.
