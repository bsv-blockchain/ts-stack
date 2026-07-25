# UHRP Lite

For simple folk

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
