# Authentication observability and account continuity

Wallet Toolbox authentication uses the SDK's generic `TelemetryConfig`. The
same sink can correlate SDK overlay resolution, UMP account lookup, WAB HTTP,
wallet snapshot, and authentication state-transition events.

```ts
import {
  LookupResolver,
  TelemetryConfig
} from '@bsv/sdk'
import {
  OverlayUMPTokenInteractor,
  WABClient
} from '@bsv/wallet-toolbox'

const telemetry: TelemetryConfig = {
  minimumSeverity: 'info',
  sink: {
    capture: event => supportReporter.capture(event)
  },
  beforeSend: event => ({
    ...event,
    attributes: {
      ...event.attributes,
      applicationVersion: '4.7.0',
      operatingSystem: 'ubuntu'
    }
  })
}

const resolver = new LookupResolver({ telemetry })
const ump = new OverlayUMPTokenInteractor(resolver, undefined, telemetry)
const wab = new WABClient('https://wab.example.com', { telemetry })
```

Pass the same `telemetry` configuration in
`WalletAuthenticationManagerOptions` when constructing the manager. Correlation
IDs then connect the WAB start/complete requests to account-continuity events
without exposing authentication payloads.

## Privacy boundary

Telemetry is opt-in and no-op by default. Wallet Toolbox reports operation
names, result categories, host counts, HTTP status, durations, format versions,
and correlation IDs. It never reports:

- private, presentation, recovery, or password-derived keys;
- passwords, phone numbers, OTPs, auth tokens, or request payloads;
- UMP token fields, Shamir shares, ciphertext, or transaction material;
- wallet snapshots or decrypted profile data.

The SDK sanitizes events before and after consumer enrichment. Sink failures do
not affect authentication or wallet behavior.

## Account-state rules

`authenticationFlow` starts as `unknown`. A password cannot create a wallet
until account lookup has completed.

An empty UMP answer means `new-user` only when every selected overlay host
settled successfully and returned an empty output list. Timeout, host failure,
malformed response, semantic rejection, or a malformed UMP token raises
`UMPTokenLookupError`. Multiple distinct valid UMP tokens are also treated as
ambiguous instead of choosing one by response order. Applications should
present retry and account-recovery options for these errors, never a
new-password prompt.

WAB completion uses an explicit `accountStatus` or `existingUser` response when
available. For older WAB servers it derives the status from the established
protocol: a new account returns the temporary presentation key, while an
existing account returns its stored key. If WAB identifies an existing account
but UMP authoritatively appears absent, `WABAccountContinuityError` prevents
new-wallet creation.

Temporary WAB authentication state expires after ten minutes by default and is
cleared when authentication is cancelled, completed, or destroyed.

Snapshot initialization is also fail-closed. Awaiting `manager.ready` rejects
when a supplied snapshot cannot be loaded instead of silently resetting the
manager into onboarding.

## WAB transport

Every WAB endpoint uses one transport with:

- HTTPS enforcement, with plain HTTP limited to localhost development;
- a hard wall-clock timeout;
- bounded JSON request and response sizes;
- rejected redirects and omitted ambient credentials;
- typed, privacy-safe failures and correlated telemetry.

Configure `timeoutMs`, `maxRequestBytes`, and `maxResponseBytes` in `WABClient`
options when the defaults of 10 seconds and 1 MiB are not appropriate.
