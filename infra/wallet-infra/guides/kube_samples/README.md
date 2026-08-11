# Wallet infrastructure Kubernetes samples

These files demonstrate the workload contract; they are not a production
environment. Replace the checked-in application image with the release tag and
digest verified for the source revision being deployed.

The sample MySQL Deployment is classified `example-not-production`.
Production must replace it with a managed database or operator-owned stateful
workload that defines replication, upgrades, disruption handling, capacity
alerts, encrypted backups, and restore tests.

Create `wallet-secrets` and `mysql-secrets` through the operator's secret
manager. `wallet-secrets` supplies `SERVER_PRIVATE_KEY` and
`KNEX_DB_CONNECTION`; `mysql-secrets` supplies `MYSQL_ROOT_PASSWORD`. Never
commit either Secret object or a literal credential.

The wallet application completes storage migration and initialization before it
starts serving port 8080. Its public root response is used for startup,
readiness, and liveness checks. The application runs without capabilities as a
non-root user on a read-only root filesystem. MySQL retains a writable PVC and
has separate startup, readiness, and liveness checks.
The application pre-stop delay allows endpoint withdrawal before `SIGTERM`;
shutdown then stops monitor tasks, drains the storage server, and closes wallet
storage. The sample remains a maintenance-controlled monitor singleton and
records that posture in annotations. Do not add a PodDisruptionBudget or HPA
until monitor leadership, shared sessions, rate limits, and storage semantics
are proven. A hostname topology preference is already present for a future
replica-safe API tier.

The sample trusts exactly one reverse-proxy hop because Kubernetes ingress is
expected to sit directly in front of it. Set
`WALLET_STORAGE_TRUST_PROXY_HOPS=0` for direct exposure, or to the exact known
hop count for a different topology. Never trust an arbitrary forwarding chain.
It also sets `WALLET_STORAGE_BIND_HOST=0.0.0.0` because nginx is disabled and a
Kubernetes Service must reach the application over the pod's IPv4 address.
It also uses the existing official-image `default` monitor task profile. A
multi-user provider should set
`WALLET_STORAGE_MONITOR_STARTUP_TASK_MODE=multiuser`, keep exactly one monitor
leader, and supply matching Arcade URL/callback-token configuration when SSE
status delivery is enabled.

The ConfigMap retains the standard managed-change work budgets: at most eight
new change outputs and four fee-positive legacy migration inputs per action,
with exact pending-plan comparison beginning above 16 settled inputs. These are
CPU, fee, transaction-size, and BEEF-ancestry work bounds rather than balance
or spendability limits. Operators can tune the three
`WALLET_STORAGE_MANAGED_CHANGE_*` values after measuring action input counts,
serialized BEEF size, fee, and broadcast outcomes. Every setting accepts `-1`,
but an unlimited value can make one request consume substantially more CPU and
memory and should not be combined casually with increased API concurrency.

The optional monitor operator service is disabled in this sample. If enabled,
run it only on the singleton `all` or `monitor` pod, mount its private key and
allowed identity keys from the secret manager, use a port distinct from the
public storage listener, and expose it only through an operator-private
ClusterIP, tunnel, or equivalent access path. Its `/healthz` is suitable for
that singleton's probes; do not route the monitor administration port through
the public Wallet Storage Ingress.

Wallet Storage is a public protocol service. Its default browser policy remains
credential-free wildcard CORS, including opaque origins. Configure an exact
allowlist only when the deployment intentionally serves a closed caller set.

Before rollout, record the current image digest and database schema, take and
verify a database backup, and confirm sufficient PVC capacity. Roll back the
application digest only when the prior version supports the current schema;
otherwise follow the database restore procedure first.
