# Telemetry

The SDK exposes a small, vendor-neutral telemetry interface for operational
events. It is disabled by default and does not select a monitoring provider.
A consumer can adapt it to OpenTelemetry, Sentry, a crash reporter, or an
internal support-event pipeline.

```ts
import { LookupResolver, TelemetryConfig, TelemetryEvent } from '@bsv/sdk'

const telemetry: TelemetryConfig = {
  minimumSeverity: 'info',
  sink: {
    capture(event: Readonly<TelemetryEvent>) {
      supportEvents.enqueue(event)
    }
  },
  correlationIdFactory: () => tracing.currentCorrelationId(),
  beforeSend: event => ({
    ...event,
    attributes: {
      ...event.attributes,
      applicationVersion: '4.7.0',
      platform: 'linux'
    }
  })
}

const resolver = new LookupResolver({ telemetry })
```

`capture` never throws into SDK behavior. Synchronous and asynchronous sink
failures are isolated. Events are sanitized before `beforeSend` and sanitized
again afterward, so consumer enrichment cannot bypass the redaction boundary.
Sinks should only enqueue work: telemetry export must not be awaited on a
wallet, bridge, authentication, or storage request path.

Long-lived hosts can pass `enabled: () => currentDiagnosticsPreference` to
honor runtime opt-in/opt-out changes without reconstructing the wallet.

## Timed and correlated work

`Telemetry.startSpan()` and `Telemetry.withSpan()` record high-resolution
monotonic durations while retaining wall-clock start times. Spans use
W3C-compatible 32-character trace IDs, 16-character span IDs, explicit
parentage, kinds, and status. Sibling work can run in parallel without losing
its parent:

```ts
import { Telemetry, formatTraceparent, instrumentWallet } from '@bsv/sdk'

const dispatcher = new Telemetry(telemetry)
const walletAtBoundary = instrumentWallet(wallet, dispatcher, {
  component: 'react-native-bridge',
  kind: 'server'
})

await dispatcher.withSpan(
  'wallet.storage.rpc',
  { component: 'storage-client', kind: 'client', carrier: args },
  async span => {
    const traceparent = formatTraceparent(span.context)
    await fetch(storageUrl, {
      method: 'POST',
      headers: traceparent == null ? {} : { traceparent }
    })
  }
)
```

The first BRC-100 argument object is an explicit context carrier. Consumers and
Wallet Toolbox layers can use `contextFor`, `bindContext`, and `linkContext`
without modifying or serializing wallet arguments. This is the portable
browser and React Native propagation mechanism. Node hosts should provide a
`TelemetryContextManager` backed by `AsyncLocalStorage` so database queries and
other asynchronous descendants inherit the active request automatically.

`formatTraceparent` and `parseTraceparent` propagate context over HTTP using
W3C Trace Context. Invalid, unsupported-version, oversized, and all-zero
headers are ignored.

## Runtime measurements

Hosts may provide `TelemetryRuntimeMetrics` to add privacy-safe CPU, garbage
collection, heap, or event-loop deltas to completed spans. Availability varies
by runtime: wall-clock and monotonic duration are always available, while a
browser or React Native runtime must not label inferred waiting time as exact
CPU or GC time. Metric names and units should be stable scalar attributes, such
as `runtime.cpu_ms`, `runtime.gc_ms`, and `runtime.event_loop_utilization`.

Telemetry work has its own cost. Exporters should measure queue time, encoding
time, batch size, dropped-event counts, retry counts, and export latency as
separate telemetry events. Those exporter events must be prevented from
recursively reporting themselves.

The event schema intentionally permits scalar attributes only. Names and values
associated with passwords, private or presentation keys, recovery material,
tokens, OTPs, Shamir shares, ciphertext, and snapshots are redacted. Common key
encodings and large encoded blobs are also removed from diagnostic text. Error
stacks are disabled by default and should be enabled only for a trusted sink.

Redaction is a defense in depth measure, not permission to attach sensitive
objects. Producers and consumers must never add request payloads, keys, wallet
snapshots, encrypted factors, or transaction material to telemetry.

High-cardinality identity, origin, URL, query-text, and transaction attributes
are not emitted by the generic instrumentation. A wallet vendor may attach a
bounded origin category or one-way pseudonymous cohort under its own consent,
retention, and privacy policy, but must not put raw credentials, request
payloads, SQL, authentication headers, or wallet data into an event.

`LookupResolver.queryDetailed()` returns the ordinary lookup answer together
with host-settlement evidence. Security-sensitive code can use the counts to
distinguish an authoritative empty result from timeouts, malformed responses,
semantic rejection, or partial availability.
