# UHRP Lite

For simple folk

See [Service Resource Profiles](../../docs/reference/service-resource-profiles.md)
for list, upload, retention, cache, response, and connection ceilings.

## Request limits and trusted proxies

Post-authentication routes use two rate-limit stages: 300 requests per minute
per source IP before authentication, then 1,000 requests per minute per
authenticated identity before payment and route work. Both return HTTP 429 with
`ERR_RATE_LIMITED`.

The defaults can be changed with:

- `UHRP_PRE_AUTH_RATE_LIMIT_MAX` and
  `UHRP_PRE_AUTH_RATE_LIMIT_WINDOW_MS`
- `UHRP_AUTHENTICATED_RATE_LIMIT_MAX` and
  `UHRP_AUTHENTICATED_RATE_LIMIT_WINDOW_MS`

Invalid or unbounded values fail startup. Express ignores forwarding headers
by default. Set `TRUST_PROXY_HOPS` to a value from 0 through 10 only when the
service is behind that exact number of trusted reverse proxies; never expose a
proxy-configured instance directly to untrusted clients. The default in-memory
store enforces limits per process, so replicated deployments must also enforce
an aggregate policy at their trusted ingress until a shared store is configured.

Browser callers are accepted from any valid HTTP(S) origin by default without
cookie credentials. Set `UHRP_CORS_MODE=allowlist` and
`UHRP_CORS_ALLOWED_ORIGINS` for an exact opt-in list, or use `disabled` to
reject Origin-bearing requests while keeping mobile, server, and command-line
clients available.

`PUT /put` does not buffer the object in memory. It validates the HMAC,
expiry, declared size, and optional `Content-Length` first, streams up to
`UHRP_UPLOAD_MAX_BODY_BYTES` into a private temporary file, hashes
incrementally, and exclusively commits the completed object without
overwriting an existing file or symlink.

Object identifiers are flat Base58 names resolved as direct children of the
CDN root. Path separators, traversal forms, absolute paths, percent escapes,
dot files, and repeated-key query shapes are rejected before wallet, body, or
filesystem work (GHSA-v356-28v3-rj46). The production static server reads from
the same canonical root used by the upload writer.

`PUT /put` is intentionally reachable before BRC-103 middleware because the
pre-signed HMAC is its upload credential. Treat `SERVER_PRIVATE_KEY` as a
high-value secret: anyone who can read it can authorize writes for otherwise
valid object names.

## Advertisement and ownership trust

The public UHRP token cryptographically authenticates the host identity, hash,
location, expiry, size, and host-derived locking key. Uploader identity and the
local object identifier are not UHRP wire fields. For owner-only list, find,
and renewal operations, this service therefore requires a locally
server-signed wallet metadata envelope and verifies it against the exact token,
BEEF output, and wallet tags. Outputs created before that envelope existed
remain available to owner list/find/renew flows through a bounded legacy path:
the host-signed on-chain token is authoritative for the hash, location, expiry,
size, and host, while the local wallet's legacy tags retain the uploader,
object-name, and MIME association. A legacy renewal writes the current signed
envelope, upgrading the record in place. Present-but-invalid signed metadata
never falls back to legacy handling. Public retrieval of an otherwise valid
on-chain advertisement is unaffected.

Billable upload and renewal sizes come from authenticated bytes/metadata, not
caller-editable tags. Pricing errors fail closed. CDN responses force arbitrary
uploaded bytes into a sandboxed attachment with MIME sniffing disabled so an
upload cannot execute with the API origin's browser authority.

## CHIRP complete-host support

Authenticated staged-object HEAD responses have no body, including existence
and validation-error responses. Authentication signs the same empty bytes
that HTTP sends. Other methods retain their existing JSON error responses.

Authenticated staged-object PUTs parse bounded identity bytes before BRC-103
verification. The handler stages those same verified bytes rather than rereading
the consumed request stream. The parser is scoped to staged-object PUTs, rejects
compressed bodies, and retains the `CHIRP_OBJECT_MAX_BODY_BYTES` ceiling
(default 4 MiB). JSON routes, HMAC streaming `/put`, and bodyless HEAD responses
retain their existing behavior. Use SDK 2.8.9 or later for full-size authenticated
CHIRP chunks; its HTTP transport keeps its existing framing and response limits.
No object, session, advertisement or persistence migration is required.

The server also implements the BRC-167 baseline upload-session and complete-
host routes under `/chirp/v1`. Objects are stream-hashed into a deduplicated
filesystem store, a root is advertised through ordinary `tm_uhrp` only after
its complete closure validates, and `/renew` extends the whole closure lease.
Set `HOSTING_DOMAIN` to the public HTTPS origin and persist `CHIRP_DATA_DIR`
(the image uses `/data/chirp`). Staging lifetime, GC interval, closure count,
logical length, object size, and retention are bounded by the `CHIRP_*`
resource variables. Public object authorization uses a bounded in-memory
commit-membership index; tune `CHIRP_COMMIT_CACHE_ROOTS`,
`CHIRP_COMMIT_CACHE_OBJECTS`, and `CHIRP_COMMIT_CACHE_SECONDS` for the
deployment's root cardinality and memory budget. Existing UHRP routes and
storage behavior are unchanged.

Staging is deliberately bounded before a paid commit: by default the host
allows 1,024 active sessions, eight per authenticated identity, and 4,096
objects per session, while preserving 1 GiB of filesystem headroom. Configure
`CHIRP_MAX_ACTIVE_SESSIONS`, `CHIRP_MAX_ACTIVE_SESSIONS_PER_IDENTITY`,
`CHIRP_MAX_STAGED_OBJECTS_PER_SESSION`, and `CHIRP_MIN_FREE_BYTES` for the
mounted volume. `CHIRP_GC_MAX_ENTRIES` limits deletions per collection cycle;
it never disables collection merely because the store grew past the limit.
Commits of the same content root are serialized across upload sessions.
Filesystem locks fail closed. A lock is never removed automatically based only
on age because delayed stale-lock cleanup could delete a successor that
recreated the same pathname. Heartbeats keep live locks current, but an orphan
left by a crashed process requires operator removal after every writer using
the shared `CHIRP_DATA_DIR` has been stopped. Never delete a lock while any
CHIRP replica may still be writing.
