# WAB Kubernetes deployment

These manifests are operator templates. They do not create credentials and they
do not deploy themselves. Keep the WAB image tag paired with the digest verified
by the repository's infrastructure release workflow.

Create `wab-secrets` through the cluster's secret-management path with:

- `db-password`;
- `mysql-root-password`;
- any enabled identity-provider credentials;
- any optional faucet/storage private material.

Do not commit Secret manifests or literal values. Non-secret database coordinates
live in `wab-config`. Replace them when using a managed database and remove the
sample MySQL Deployment.

The WAB process applies migrations before it listens. Kubernetes startup,
readiness, and liveness checks use the public `/info` endpoint; reaching it proves
the process completed startup and bound port 8080. The application container runs
as an unprivileged user with a read-only root filesystem and no Linux
capabilities.

WAB remains a public protocol service. Wildcard, credential-free CORS is the
default so deployed apps, webviews, mobile clients, and future callers can use it.
Exact-origin allowlists and credentialed exact-origin deployments are explicit
operator choices; CSP is not an API authorization mechanism.

Back up the database and record the current schema and image digest before a
rollout. Apply the database change first, wait for its probes, then update the WAB
digest. Roll back to the prior digest only when its schema compatibility is
verified; otherwise restore through the database recovery runbook.
